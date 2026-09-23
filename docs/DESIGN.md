# JevCode design

Status: draft v2, 2026-09-19 (v1 plus the design review of the same day, §18). Versions and
adopt/reject items marked `[R]` are taken from `docs/RESEARCH.md`; everything else follows
the build prompt and the research report the project was specified against — a private
document, not part of this repository, cited as REPORT §n. Deviations are listed in §16.

## 1. What JevCode is

A coding-agent harness in strict TypeScript for Node, with one Ink TUI, where:

- the **generator** (Claude Sonnet 5 through Anthropic or OpenRouter) only writes: it
  proposes exactly one action per step (edit, write, patch, run, read, done) behind one
  `Provider` interface;
- **Jev** (`typesafe/jev-1.13`, dated id pinned, through OpenRouter's decisions endpoint)
  makes every decision: what the step is for, which files the generator sees, whether the
  proposed action is safe, whether its output succeeded, whether the task is done, and how
  to recover from a loop;
- **code** owns control flow, budgets, sandboxing, thresholds, arithmetic, and
  checkpoints, exactly as TypeSafe frames it ("code owns control flow, the model makes
  atomic common-sense judgments", REPORT §1).

Non-goals: no framework beyond Ink and its peers, no benchmark-specific heuristics, no
generator-side autonomy over what runs or when it stops, no secrets in any artefact.

## 2. Package layout

```
JevCode/
  package.json  tsconfig.json  vitest.config.ts  .nvmrc  .npmrc  .env(.example)  README.md
  bin/jevcode.js                 launcher: enable compile cache, install the no-network
                                 interceptor when asked (§12), import dist bundle
  src/
    cli/main.tsx                 parseArgs, dispatch: run | config | bench | perf | --resume
    cli/args.ts                  flag schema: common flags plus per-command flags (§3.1),
                                 exported as `ParsedFlags`, consumed by `resolveConfig`
    config/{types,defaults,resolve,env,mask,validate}.ts
    errors.ts                    typed error hierarchy and exit codes (§11)
    core/types.ts                shared contract (§4): Action, Plan, Step, Events, Engine,
                                 Provider, Decider, Workspace, Sandbox, Checkpoint
    core/events.ts               typed EventEmitter for engine -> renderer (EngineEvent, §4)
    core/hash.ts  core/atomic.ts  core/redact.ts  core/time.ts  core/json.ts
    jev/client.ts                port of lab.mjs raw()/ask(): fetch, retry, redaction
                                 (spend accounting moved to the engine, §6)
    jev/types.ts  jev/validate.ts  jev/confidence.ts  jev/questions.ts  jev/mock.ts
    spend/meter.ts               SpendMeter: split generator/Jev, cap, never throws (§6)
    provider/{types,anthropic,openrouter,mock,sse,actions,prompts}.ts
    sandbox/{run,kill,paths,seatbelt}.ts
    workspace/{files,candidates,edit,patch,tests,git}.ts   git.ts: the only module that spawns git
    loop/engine.ts               the step loop (§6)
    loop/stages/{intent,context,propose,risk,execute,judge,complete,replan,choose}.ts
    loop/{plan,window,loopdetect,budget,stop}.ts
    loop/generator-only.ts       Jev-off condition used by the bench; implements Engine
    checkpoint/{store,resume,run-id}.ts
    tui/{App,Transcript,Decisions,StatusLine,Confirm,useEngine}.tsx  tui/plain.ts
                                 plain.ts also exports the shared transcript-item model
                                 (itemsFromEvent, formatTranscriptItem) used by the engine's transcript.log
    tui/devtools-stub.ts         empty default export aliased over react-devtools-core (§12)
    bench/{runner,report,metrics,conditions}.ts
    bench/swebench/{tasks,loader,evaluator,predictions}.ts
    bench/terminalbench/{tasks,loader,evaluator,harbor-adapter}.ts
    perf/{first-frame,step-overhead,render-lag,jev-latency,main}.ts
  bench/data/swebench-verified-30.json      checked-in subset (instance records + spec + eval.sh)
  bench/data/swebench-verified-30.gold.json gold patches, mocked bench only
  bench/data/terminal-bench/manifest.json   all 66 TB 4.0 tasks with feasibility fields
  bench/data/terminal-bench/tasks/<task>/   the 10 checked-in tasks: instruction.md, task.toml,
                                            environment/ (Dockerfile, data), tests/
  bench/data/terminal-bench/gold/<task>/    upstream solution/, mocked bench only
  bench/harbor/jevcode_agent.py             Harbor installed-agent adapter
  test/unit/**  test/live/**  test/fixtures/**
  docs/RESEARCH.md  docs/DESIGN.md  docs/DECISIONS.md  docs/research/*.md
```

One package, ESM, `"type": "module"`, strict TypeScript with `noUncheckedIndexedAccess`,
`exactOptionalPropertyTypes`, `verbatimModuleSyntax`, `erasableSyntaxOnly`, no `any`
(lint rule: `@typescript-eslint` is *not* added; `grep -n ': any\|as any\|<any>' src` is a
CI check in `npm run typecheck`, alongside a grep asserting that `workspace/git.ts` is the
only module that spawns `git`, §8). Node pinned in `.nvmrc`, `engines`, and `.npmrc`
(`engine-strict=true`) `[R]`.

## 3. Configuration

Precedence, highest first: CLI flag > process env var > `./.env` > `<JEVCODE_EXTRA_ENV_FILE>`
> config file > default. `.env` files are parsed with `node:util` `parseEnv`; they are read
into an isolated map, never into `process.env`.

| Setting | Flag | Env | Default |
| --- | --- | --- | --- |
| Generator provider | `--provider` | `JEVCODE_PROVIDER` | `anthropic` |
| Generator model | `--model` | `JEVCODE_MODEL` | `claude-sonnet-5` |
| Generator key | `--api-key` | `ANTHROPIC_API_KEY` / `OPENROUTER_API_KEY` by provider, or `JEVCODE_API_KEY` | none |
| Generator base URL | `--base-url` | `JEVCODE_BASE_URL` | `https://api.anthropic.com` / `https://openrouter.ai/api/v1` |
| Generator temperature | `--temperature` | `JEVCODE_TEMPERATURE` | unset: the parameter is **not sent** (Claude Sonnet 5 returns 400 for any non-default `temperature`/`top_p`/`top_k`, and OpenRouter lists no `temperature` in its supported parameters, research `07` §1.1, §2.4); when set explicitly it is sent and recorded per call as `temperature`, otherwise recorded as `null` |
| Generator max tokens | `--max-tokens` | `JEVCODE_MAX_TOKENS` | `4096` |
| Decider base URL | `--jev-base-url` | `JEV_BASE_URL` | `https://openrouter.ai/api/alpha/decisions` |
| Decider key | `--jev-api-key` | `JEV_API_KEY`, falling back to `OPENROUTER_API_KEY` | none |
| Decider model | `--jev-model` | `JEV_MODEL` | `typesafe/jev-1.13-20260917` `[R]` (aliases such as `typesafe/jev-1.13` are accepted and resolved on first call; §5.4 rule 7) |
| Spend cap (USD, generator + Jev) | `--spend-cap` | `JEVCODE_SPEND_CAP_USD` | `2.00` |
| Max steps | `--max-steps` | `JEVCODE_MAX_STEPS` | `40` |
| Max wall time | `--max-wall` (e.g. `30m`) | `JEVCODE_MAX_WALL` | `30m` |
| Max replans | `--max-replans` | `JEVCODE_MAX_REPLANS` | `5` |
| Completion threshold | `--complete-threshold` | `JEVCODE_COMPLETE_THRESHOLD` | `0.85` |
| Impossible threshold | `--impossible-threshold` | `JEVCODE_IMPOSSIBLE_THRESHOLD` | `0.85` |
| Workspace | `--workspace` | `JEVCODE_WORKSPACE` | cwd; the resolved value is `realpath`ed at first use (§8) |
| Runs dir | `--runs-dir` | `JEVCODE_HOME` | `~/.jevcode/runs` |
| Extra .env file | `--extra-env-file` | `JEVCODE_EXTRA_ENV_FILE` | none (no second dotenv is read unless the row is set) |
| Config file | `--config` | `JEVCODE_CONFIG` | `./jevcode.json`, else `~/.config/jevcode/config.json` |
| Sandbox profile | `--sandbox` | `JEVCODE_SANDBOX` | `auto` (seatbelt on darwin, none elsewhere) |
| Generator pricing override | | `JEVCODE_PRICE_IN_PER_M`, `JEVCODE_PRICE_OUT_PER_M` | table in `config/defaults.ts` `[R]` |

Risk thresholds 0.3 and 0.7 are constants from the prompt, exported from
`loop/stages/risk.ts`, not configurable. Plan-claim acceptance constants 0.7 / 0.3
(`PLAN_ACCEPT_THRESHOLD`, `PLAN_REJECT_THRESHOLD`) are exported from `loop/plan.ts` (§6).

Decider model, accepted forms per REPORT §2: `typesafe/jev-1.13-20260917`,
`typesafe/jev-1.13`, `jev-1.13`, any casing; compared case-insensitively without the
`typesafe/` prefix (§5.4 rule 7).

Validation happens at first use: `resolveConfig()` returns a `ResolvedConfig` with every
value plus its `source` (`flag` | `env` | `dotenv:<path>` | `file:<path>` | `default`);
`config.generator()` and `config.decider()` validate their section (key present, URL
parses, model non-empty, numbers finite and positive) on first call and throw
`ConfigError` naming the setting and the sources consulted. `jevcode run` renders its
first frame before either is called. It also renders it before `resolveConfig()` runs; the
resolved values reach the TUI through `run:ready` (§6, §12). `jevcode config` prints the
resolved table with the source column; secret values are shown as
`<source> (sha256:1a2b3c4d)`, the first 8 hex characters of the SHA-256 of the key, never
any characters of the key itself. `config/mask.ts` exports `fingerprint(secret): string`
for this. `resolveConfig()` also assembles the `SecretSet` that seeds `redact()` (§8.4).

### 3.1 Commands and flags

Exactly one flag list exists (`cli/args.ts`); `--task` is not a flag.

```
jevcode run  <task text as positional> | --task-file <path> | stdin when stdin is not a TTY
  common: --provider --model --api-key --base-url --temperature --max-tokens
          --jev-base-url --jev-api-key --jev-model
          --spend-cap <usd> --max-steps <n> --max-wall <dur> --max-replans <n>
          --complete-threshold <p> --impossible-threshold <p>
          --workspace <dir> --runs-dir <dir> --extra-env-file <path> --config <file>
          --sandbox auto|seatbelt|none --no-network --plain
  run only: --resume <run-id>   (mutually exclusive with task text / --task-file / stdin)
            --force             (with --resume: resume a run whose stopReason is `complete`)
            --perf-exit-after-first-frame   (hidden; used by perf/first-frame.ts)
jevcode config   [--json]   prints the resolved table, secrets fingerprinted, source column,
                            active sandbox level and what it does not cover (§8)
jevcode bench    --suite swebench|terminal-bench|all  --tasks <n>  --task-id <id>[,<id>...]
                 --conditions jev-on,jev-off  --concurrency <n>  --live
                 --spend-cap <usd> (bench total; required with --live)
                 --task-spend-cap <usd> (per run, default 2.00)  --allow-model-alias
                 --resume <bench-id>  --out <dir>  plus every common flag
jevcode perf     [--live] [--out <file>]
```

Only if the Harbor adapter needs to select the jev-off condition from the CLI: a hidden
`--condition jev-on|jev-off` on `run`; otherwise the bench picks the condition in-process
and no such flag exists.

## 4. Core contract (`src/core/types.ts`)

**Contract 1.1 (2026-09-20, interactive TUI; the authoritative list is `docs/TUI-DESIGN.md` §15).** Every
addition for the interactive session is additive and optional on the existing types, so the wave-0 fakes,
`run-events.json`, the provider test helpers and `store.ts`'s shape guards load unchanged and
`CheckpointEnvelope.version` stays `1`: optional fields on `run:ready` (`sessionId`, `parentRunId`, `sandbox`,
`noNetwork`, `maxReplans`), `ConfirmRequest` (`matchesIntent`, `jevLatencyMs`), `SpendSnapshot.parent`,
`GeneratorConfig.priced`, `RunMeta` (`sessionId`, `parentRunId`, `source`, `title`, `git`, `instructions`),
`CheckpointState` (`pendingDirectives`, `undoLog`, `checkpointDegraded`), `StepRecord.planAfter`,
`StepTiming.imagesMs`, `Confirmer.confirmDetailed?`, and the new event types (`steer:queued`, `steer:applied`,
`steer:withdrawn`, `pause:requested`, `retry`, `retry:settled`, `budget:warn`, `budget:clamp`, `budget:override`,
`blocking:request`, `blocking:resolved`, `workspace`, `secret-ack`, labelled `notice`). The one named exception is
`Engine`, which the repository alone implements: it gains the required methods `steer`, `unsteer`, `pause`,
`retryNow` and `annotate`, and `abort(reason, opts?)` widens to `'human_abort' | 'signal' | 'error'` with
`{ signal?, error? }`. Every prescribed assignment is a conditional spread because the tree compiles with
`exactOptionalPropertyTypes` (TUI-DESIGN §15 header). The `Action`, `Plan`, `Decision` and `EngineEvent` shapes
below are unchanged.

```ts
export type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

// ---- generator actions (the only thing the generator produces) ----
export type Action =
  | { kind: 'read';  paths: string[] }                       // show files, bounded
  | { kind: 'edit';  path: string; old: string; new: string } // exact, unique match
  | { kind: 'write'; path: string; content: string }         // create or overwrite
  | { kind: 'patch'; diff: string }                          // unified diff, -p1
  | { kind: 'run';   command: string; timeoutMs?: number }   // sh -c in sandbox
  | { kind: 'done';  summary: string };                      // proposal to finish
export interface Proposal { goal: string; action: Action; plan: PlanDraft; rawText: string }
export interface PlanDraft { done: string[]; remaining: string[]; openProblems: string[] }

// ---- persistent plan ----
export interface PlanItemDone { text: string; evidence: { step: number; judged: number } } // judged -1 = not judged (jev-off)
export interface Plan {
  done: PlanItemDone[];
  remaining: string[];
  unverified: { text: string; step: number; judged: number }[];   // claimed, done_<j> in [0.3, 0.7), still in remaining
  openProblems: string[];                                         // generator entries, replaced each step
  harnessProblems: { kind: 'replan' | 'rejected_claim' | 'stale_plan'; text: string; step: number }[]; // harness-owned (§6 Plan)
}

// ---- execution ----
export interface ExecResult {
  ok: boolean;                              // exitCode === 0 && killedBy === null
  exitCode: number | null; signal: string | null;
  stdout: string; stderr: string;           // head (<= maxOutputBytes) + rolling tail (16 KB); see §8
  truncated: boolean;                       // output cap passed; never a kill, never an error
  bytesSeen: number;
  killedBy: 'timeout' | 'wall_time' | 'abort' | null;   // set by the code path that kills, before signalling
  timedOut: boolean;                        // derived: killedBy === 'timeout'
  orphans: number[];                        // pids from the kill snapshot still alive after SIGKILL (§8)
  sandboxExecDenied: boolean;               // sandbox-exec itself failed to exec the binary (exit 71)
  durationMs: number;
}
export type ActionOutcome =
  | { status: 'executed'; exec?: ExecResult; summary: string; changedFiles: string[] }
  | { status: 'noop'; summary: string }             // `done` proposal that passed risk: nothing executed, nothing changed
  | { status: 'blocked'; reason: string }
  | { status: 'declined'; reason: string }          // confirmer returned false at review (TUI human or bench confirmer)
  | { status: 'failed'; error: string }             // patch did not apply, path escape, stage failure (§6)
  | { status: 'interrupted'; exec?: ExecResult };   // harness cancelled execute (signal, human abort, wall time); partial exec for `run`

// ---- Jev ----
export type Question =
  | { type: 'noul'; instructions: Json; criteria?: { true: Json; false: Json } }   // criteria omitted only for context Nouls (§5.5)
  | { type: 'choice'; instructions: Json; criteria: Record<string, Json | null> }
  | { type: 'score'; instructions: Json; criteria: Json[] };
export type Answer =
  | { type: 'noul'; noul: number }
  | { type: 'choice'; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: 'score'; score: number; legend: Record<string, Json>; probabilities: Record<string, number>; confidence: number };
export interface JevRequest { model: string; state: Json; questions: Record<string, Question> }
export interface JevResponse {
  model: string; answers: Record<string, Answer>;
  usage: { input_tokens: number; output_tokens: number; cost: number }; id?: string; provider?: string;
}
export interface Decision {              // one row in the decisions pane and decisions.jsonl
  step: number; stage: StageName; id: string; question: Question; answer: Answer;
  probability: number;                   // P(chosen): noul p, choice probabilities[choice], score p_{k*}
  confidence: number;                    // harness-computed (§5.3)
  verdict?: 'ok' | 'review' | 'block' | 'chosen' | 'overridden' | 'fallback'; // risk: ok/review/block; intent, replan: chosen/overridden/fallback
  latencyMs: number;                     // the parent request's latency; display only, not a metric source
  requestHash: string; servedModel?: string;   // servedModel only when it differs from the configured id (§5.4 rule 7)
}
export interface JevRequestRecord {      // one per Decider.ask() call (jev.jsonl, §9); the metric source for Jev latency
  step: number; stage: StageName; requestHash: string; latencyMs: number;
  questions: number; usage: TokenUsage; model: string; attempts: number;
}

// ---- loop ----
export type StageName = 'replan' | 'intent' | 'context' | 'propose' | 'risk' | 'execute' | 'judge' | 'complete';
export type Intent = 'investigate' | 'edit' | 'verify' | 'fix_environment' | 'finish';   // what the generator sees (effective intent)
export type IntentAnswer = Intent | 'none_of_these';                                      // what Jev may answer
export type StopReason =
  | 'complete' | 'max_steps' | 'spend_cap' | 'wall_time' | 'max_replans' | 'human_abort' | 'signal'
  | 'replan_stop' | 'impossible' | 'generator_done' /* Jev-off only */ | 'error';
export type ReplanMove = 'change_approach' | 'gather_context' | 'fix_environment' | 'revert_changes' | 'stop_and_report' | 'none_of_these';
export interface ReplanDirective { move: ReplanMove; probability: number; confidence: number; taskImpossible: number; text: string }
export interface StepRecord {
  step: number; startedAt: string;
  intent: Intent | null;                 // effective intent (null when the stage was not reached)
  intentAnswer: IntentAnswer | null;     // Jev's raw Choice, escape option included
  contextFiles: string[];
  proposal: Proposal | null; risk: RiskAssessment | null; outcome: ActionOutcome | null;
  judge: JudgeResult | null; completion: number | null; decisions: Decision[];
  jevRequests: JevRequestRecord[];
  usage: StepUsage; timing: StepTiming;
  loopSignatures: string[];              // 0..3 entries, see §6; detector counters live in state.loopDetector (§9)
  stoppedAt?: 'step_start' | 'before_execute' | 'complete';   // on the stopping step: which budget check fired (§6)
  interruptedAt?: { stage: StageName; reason: 'signal' | 'human_abort' | 'wall_time' | 'error' }; // §9.1 rules 2 and 3
  error?: { stage: StageName; code: string; message: string }; // stage failure (§6), redacted
}
export interface RiskAssessment {
  dims: Record<'destructive' | 'out_of_scope' | 'plan_mismatch' | 'irreversible',
    { risk: number; expected: number; tailMass: number; bound: 'expected' | 'tail'; confidence: number; level: number }>;
  risk: number; verdict: 'ok' | 'review' | 'block'; reason: string;
}
export interface JudgeResult {
  succeeded: number; errorPresent: number; newInfo: number;
  tests:
    | { source: 'parsed'; allPassed: boolean; passed: number; failed: number; errors: number }  // code-computed, never a Jev question
    | { source: 'judged'; allPassed: number }                                                  // tests_pass_unparsed Noul
    | null;                                                                                    // no test command ran this step
  doneClaims: { text: string; judged: number; accepted: boolean }[];                          // done_<j> Nouls (§6 Plan)
}
export interface StepUsage { generator: TokenUsage; jev: TokenUsage }
export interface TokenUsage { inputTokens: number; outputTokens: number; costUsd: number; calls: number }
export interface StepTiming { generatorMs: number; jevMs: number; execMs: number; harnessMs: number; totalMs: number }
export interface RunResult {
  runId: string; mode: EngineMode; stopReason: StopReason; steps: number; wallMs: number;
  usage: StepUsage; timing: StepTiming;                            // run totals
  tokensPerStep: number[]; generatorTokensPerStep: number[]; jevTokensPerStep: number[];   // per committed step; tokensPerStep is the pointwise sum
  jevLatencyMs: number[];                 // raw, one entry per Jev HTTP request (jev:request), not per question
  counters: { blocked: number; reviews: number; declined: number; failed: number; loops: number; replans: number; reads: number };
  finalPlan: Plan; error?: SerializedError; resolvedJevModel: string | null; jevModelDrift: { step: number; served: string } | null;
}

// ---- provider ----
export interface GenerateRequest { system: string; messages: ChatMessage[]; maxTokens: number; temperature: number }
export interface ChatMessage { role: 'user' | 'assistant'; content: string }
export interface GenerateResult { text: string; usage: TokenUsage; model: string; stopReason: string; latencyMs: number }
export interface Provider {
  readonly name: 'anthropic' | 'openrouter' | 'mock'; readonly model: string;
  generate(req: GenerateRequest, opts: { signal: AbortSignal; onDelta?: (text: string) => void }): Promise<GenerateResult>;
}
export interface Decider {
  readonly model: string;
  ask(state: Json, questions: Record<string, Question>, opts: { signal: AbortSignal; stage: StageName; step: number }):
    Promise<{ answers: Record<string, Answer>; usage: TokenUsage; latencyMs: number; model: string; requestHash: string; attempts: number }>;
}

// ---- confirmation ----
export interface ConfirmRequest { id: string; step: number; proposal: Proposal; risk: RiskAssessment }
export interface Confirmer {
  /** Resolves true (approve) or false (decline). Rejects with AbortError when `signal` aborts. Never auto-approves. */
  confirm(req: ConfirmRequest, opts: { signal: AbortSignal }): Promise<boolean>;
}

// ---- spend ----
export type SpendSource = 'generator' | 'jev';
export interface SpendSnapshot { generator: TokenUsage; jev: TokenUsage; totalUsd: number; capUsd: number; exceeded: boolean }
export interface SpendMeter {
  add(source: SpendSource, usage: TokenUsage): SpendSnapshot; // never throws; records (and forwards to the parent) first, then evaluates
  exceeded(): boolean;                                         // totalUsd >= capUsd, or parent.exceeded()
  snapshot(): SpendSnapshot;
  restore(s: SpendSnapshot): void;                             // --resume: restores this meter only, does not re-add to the parent
  child(capUsd: number): SpendMeter;                           // bench: per-run meter under the shared bench meter
}

// ---- workspace and sandbox (engine <-> workspace/*, sandbox/*; stubbed by bench/perf mocks) ----
export interface Candidate { path: string; bytes: number }                       // produced by workspace/candidates.ts
export interface CandidateView extends Candidate { mentionsInTask: number; touchedThisRun: boolean }
  // built by loop/stages/context.ts, which also owns the <= 300-path pre-filter (mention count, then recency)
export interface FileView { path: string; content: string; bytes: number; truncatedBytes: number }
export type TestRunner = 'pytest' | 'jest' | 'vitest' | 'npm' | 'cargo' | 'go' | 'unknown';
export interface TestCommand { command: string; runner: TestRunner }
export interface TestCounts { passed: number; failed: number; errors: number; skipped: number }
export interface WorkspaceInfo { root: string; git: boolean; hasTests: boolean; testCommand: TestCommand | null }
export interface Workspace {
  readonly root: string;                                              // realpath(workspace)
  info(): Promise<WorkspaceInfo>;                                     // workspace/tests.ts detects testCommand
  listCandidates(): Promise<Candidate[]>;                             // cached listing (§8); binaries, > 1 MB, symlinks, secret paths dropped
  read(path: string, maxBytes: number): Promise<FileView>;            // PathEscapeError / SecretPathError; head kept, truncatedBytes recorded
  applyEdit(a: Extract<Action, { kind: 'edit' }>): Promise<{ changedFiles: string[] }>;   // EditError('no match' | 'N matches'); atomic write
  writeFile(a: Extract<Action, { kind: 'write' }>): Promise<{ changedFiles: string[]; created: boolean }>;
  applyPatch(diff: string): Promise<{ changedFiles: string[] }>;      // PatchError { hunk }; all-or-nothing
  parseTestOutput(runner: TestRunner, output: string): TestCounts | null;   // pure; pytest/jest/cargo summaries, parsed from the tail
  changedFiles(): Promise<string[]>;                                  // relative to the snapshot taken by createWorkspace() (§8)
  target(path: string): Promise<{ path: string; existsBefore: boolean; tracked: boolean; createdThisRun: boolean; recoverable: boolean }>;
}
export interface Sandbox {
  readonly level: 'seatbelt' | 'none';                                // printed by `jevcode config`
  run(command: string, opts: {
    timeoutMs: number;                                                // already clamped by the execute stage (§6, §8)
    maxOutputBytes: number;                                           // default 200 KB; passing it never kills
    signal: AbortSignal;                                              // engine.signal; kills the tree (§8)
    onOutput?: (stream: 'stdout' | 'stderr', chunk: string) => void; // live tail for the transcript
  }): Promise<ExecResult>;
  killAll(): Promise<void>;                                           // three-pass tree kill (§8); used by abort() and fatal()
}
export function createWorkspace(root: string, runDir: string): Promise<Workspace>;   // workspace/files.ts; takes the changed-files snapshot
export function createSandbox(ws: Workspace, runDir: string, profile: 'auto' | 'seatbelt' | 'none', noNetwork: boolean): Sandbox;

// ---- checkpoint contract (§9) ----
export type EngineMode = 'jev-on' | 'jev-off';
export interface WindowEntry {                                       // one element of state.recent (§5.5) and of the generator's window
  step: number; intent: Intent | null; action: string;               // "edit src/a.py", "run pytest -q", "done"
  outcome: ActionOutcome['status'] | null; reason?: string;          // blocked / declined / failed reason, verbatim, <= 600 chars
  judge?: JudgeResult; completion?: number; output?: string;         // output <= 600 chars: head 400 + tail 200
  truncated?: boolean; shownFiles: string[];                         // context files plus `read` paths for that step
  notes: string[];                                                   // "done rejected: task_complete=0.41", "unjudged: jev_http", "interrupted before judge", rejected/unverified claims
}
export interface LoopDetectorState {
  counts: Record<string, number>; lastSignature: string | null; tripped: boolean;
  replanCount: number;
  tripsBySignature: Record<string, { trips: number; directives: { step: number; directive: string }[] }>;
}
export interface CheckpointState {
  runId: string; mode: EngineMode;
  step: number;                 // number of COMMITTED steps; the next step to run is step + 1
  plan: Plan;
  window: WindowEntry[];        // exactly what loop/window.ts feeds the next prompt
  loopDetector: LoopDetectorState;
  spend: SpendSnapshot;         // cumulative generator + Jev over the whole run, all resumes
  wallMsUsed: number;           // active wall time summed across resumes; --max-wall applies to this
  timing: StepTiming; jevLatencyMs: number[]; tokensPerStep: number[];
  counters: RunResult['counters'];
  directive: ReplanDirective | null;   // replan directive pending for the next step
  lastTestRun: { step: number; command: string; passed: number; failed: number; errors: number; allPassed: boolean } | null;
  lastChangeStep: number | null; createdThisRun: string[];
  resolvedJevModel: string | null; jevModelDrift: { step: number; served: string } | null;
  stopReason: StopReason | null;
  error?: { stage: StageName; code: string };
  interrupted: { step: number; stage: StageName; proposal: Proposal | null } | null;   // §9.1 rule 1: a discarded (uncommitted) step
  resumes: number; updatedAt: string;
}
export interface CheckpointEnvelope { version: 1; checksum: string; state: CheckpointState }  // checksum = sha256 of JSON.stringify(state)
export interface RunMeta {
  runId: string; task: string; workspace: string; mode: EngineMode;
  config: Record<string, { value: string | { source: string; fingerprint: string }; source: string }>;   // secrets as fingerprints (§3)
  versions: { jevcode: string; node: string }; createdAt: string;
  overrides: { setting: string; from: string; to: string; atStep: number }[];   // appended on resume (§9)
  resumes: { resumedAt: string; previousStopReason: StopReason | null }[];
}
export interface GeneratorCallRecord {
  step: number; attempt: number; promptHash: string; model: string; temperature: number; maxTokens: number;
  usage: TokenUsage; latencyMs: number; stopReason: string; malformed: boolean;
}
export interface CheckpointStore {
  readonly dir: string;
  create(meta: RunMeta): Promise<void>;
  load(runId: string): Promise<{ meta: RunMeta; state: CheckpointState; recoveredFrom: 'state' | 'prev' }>; // CheckpointError, exit 3
  writeState(state: CheckpointState): Promise<void>;                 // write tmp + fsync; rename state.json -> state.prev.json; rename tmp -> state.json
  appendStep(r: StepRecord): Promise<void>;
  appendDecisions(d: readonly Decision[]): Promise<void>;
  appendJevRequest(r: JevRequestRecord): Promise<void>;
  appendGenerator(g: GeneratorCallRecord): Promise<void>;
  appendTranscript(line: string): Promise<void>;
  flush(): Promise<void>;                                            // awaited by shutdown() before exit
}
export function newRunId(now: Date): string;                         // §9 Run id

// ---- engine surface (loop/engine.ts and loop/generator-only.ts both implement Engine) ----
export interface RunLimits {
  maxSteps: number; maxWallMs: number; maxReplans: number; completeThreshold: number; impossibleThreshold: number;
  commandTimeoutMs: number; maxCommandTimeoutMs: number; maxOutputBytes: number;
}
export interface EngineOptions {
  task: string; mode: EngineMode; workspace: string; runsDir: string; resume?: { runId: string };
  provider: Provider; decider: Decider; confirmer: Confirmer; meter: SpendMeter;
  limits: RunLimits; sandboxProfile: 'auto' | 'seatbelt' | 'none'; noNetwork: boolean;
  now?: () => number;                                                // injectable clock for perf/unit tests
}
export interface Engine {
  readonly runId: string;
  readonly events: EngineEmitter;
  readonly signal: AbortSignal;                    // the run-level AbortSignal every generate/ask/sandbox run receives
  run(): Promise<RunResult>;                       // resolves for every StopReason including 'error'; never rejects
  abort(reason: 'human_abort' | 'signal'): void;   // idempotent; see §11 shutdown()
  status(): EngineStatus;
}
export interface EngineEmitter {
  on<T extends EngineEvent['type']>(type: T, fn: (e: Extract<EngineEvent, { type: T }>) => void): () => void;
  onAny(fn: (e: EngineEvent) => void): () => void;
}
export interface EngineStatus {
  step: number; maxSteps: number; wallMs: number; maxWallMs: number;
  stage: StageName | 'idle'; spend: SpendSnapshot; stopReason: StopReason | null;
}
export interface SerializedError { name: string; code: string; message: string; exitCode: number } // already redacted
export type EngineEvent =
  | { type: 'run:start'; runId: string; task: string; mode: EngineMode; resumedFromStep: number | null }
  | { type: 'run:ready'; runId: string; step: number; maxSteps: number; task: string; resumed: boolean }   // after resolveConfig + init/resume
  | { type: 'step:start'; step: number; startedAt: string }
  | { type: 'stage:start'; step: number; stage: StageName }
  | { type: 'stage:end'; step: number; stage: StageName; ms: number }
  | { type: 'decision'; decision: Decision }                       // one per Jev question, in request order
  | { type: 'jev:request'; record: JevRequestRecord }              // one per HTTP request
  | { type: 'intent'; step: number; intent: Intent; answer: IntentAnswer; probability: number; confidence: number }
  | { type: 'context'; step: number; files: string[]; bytes: number; candidates: number }
  | { type: 'generator:start'; step: number; attempt: number }
  | { type: 'generator:delta'; step: number; text: string }        // streamed; TUI coalesces at <= 20 fps, never dispatches per delta
  | { type: 'generator:end'; step: number; usage: TokenUsage; latencyMs: number; finishReason: string }
  | { type: 'proposal'; step: number; proposal: Proposal }         // final text; ends the live stream for this step
  | { type: 'risk'; step: number; risk: RiskAssessment }
  | { type: 'confirm:request'; request: ConfirmRequest }           // emitted immediately before the engine awaits Confirmer.confirm()
  | { type: 'confirm:resolved'; id: string; approved: boolean; aborted: boolean }
  | { type: 'exec:start'; step: number; action: Action }
  | { type: 'exec:output'; step: number; stream: 'stdout' | 'stderr'; chunk: string }
  | { type: 'outcome'; step: number; outcome: ActionOutcome }
  | { type: 'judge'; step: number; judge: JudgeResult | null; completion: number | null }
  | { type: 'plan'; step: number; plan: Plan; rejectedDone: string[]; unverifiedDone: string[] }
  | { type: 'loop:tripped'; step: number; signature: string; occurrences: number }
  | { type: 'replan'; step: number; directive: ReplanDirective }
  | { type: 'checkpoint'; step: number; ms: number }
  | { type: 'step:end'; record: StepRecord }
  | { type: 'status'; status: EngineStatus }                       // emitted after every stage:end and step:end; the only event StatusLine reads
  | { type: 'transcript'; step: number | null; level: 'info' | 'warn' | 'error'; text: string }
  | { type: 'error'; step: number | null; error: SerializedError; fatal: boolean }
  | { type: 'run:end'; result: RunResult };
```

Every event payload passes `redact()` before emit. Events are emitted in stage order within
a step; `generator:delta` events for step N are always followed by exactly one `proposal`
(or an `error`) for step N. `generate()` and `ask()` always return the paid, validated
response; nothing in this contract throws on a budget (§6).

## 5. Jev integration

### 5.1 Client (`jev/client.ts`), ported from `lab.mjs`

Same wire protocol as `lab.mjs` lines 47-73 and 79-107: `POST {JEV_BASE_URL}` with
`Authorization: Bearer`, `Content-Type: application/json`, `HTTP-Referer`, `X-Title`, body
`{ model, state, questions }`, response `{ model, answers, usage, id, provider }`. Kept from
`lab.mjs`: header capture (`x-generation-id`, `retry-after`, `x-provider-name`), text-first
parsing, `redact()` over every error string (§8.4), `sha()` request hashing, `pmap` bounded
concurrency. Changed: retry is jittered (REPORT §12 SDK policy: 500 ms doubling to 5 s,
25 % jitter, honour `Retry-After` up to 60 s; retryable = network error, 408, 429, 5xx
except 501) with 3 attempts; the client does no spend accounting: it returns `usage` and
the engine records it (§6); the key comes from config, not a hard-coded `.env` path; every
response passes `validateJevResponse()` before use; the request always sends the configured
model id verbatim (OpenRouter accepts every accepted form, REPORT §2).

Per-attempt timeout 10 s (REPORT §12 SDK default; §5 p99 < 1.3 s even at concurrency 128),
implemented as `AbortSignal.any([opts.signal, AbortSignal.timeout(10_000)])` per attempt,
3 attempts. An abort whose `reason` is a `TimeoutError` counts as a network error and is
retried; an abort with any other reason (engine deadline or SIGINT) is not retried and
rethrows `signal.reason`. Backoff and `Retry-After` sleeps also await `opts.signal`, so the
worst case for one `ask` is bounded by the engine deadline, not by 3 × 10 s + 2 × 60 s.

`core/redact.ts` is not a literal port of the `lab.mjs` single-KEY version; its
specification is §8.4.

### 5.2 Validation (`jev/validate.ts`)

Hand-written validators (no schema library): status 200, JSON object, `answers` object with
exactly the requested ids, each answer's `type` equals the question's type, `noul` in
[0, 1], `probabilities` keys equal the option keys / level indices, values in [0, 1] and
summing to 1 ± 0.05, `choice` is one of the option keys and `probabilities[choice]` is
within 1e-6 of the maximum value in `probabilities` (ties allowed: wire values are rounded to
two decimals and carry float artefacts, REPORT §6, so the argmax need not be unique; the
harness never recomputes its own argmax for a Choice: the response's `choice` is the chosen
option everywhere), `score` within [0, n−1] (no Σ k·p_k cross-check: the harness derives
risk and confidence from `probabilities`, §5.3, and REPORT §1 says the two can differ by up
to 0.02), `usage` numbers finite. Failures raise `JevResponseError` with the offending path.

Only shape failures that could be a transient bad body (not JSON, missing
`answers`/`usage`, non-finite numbers, probabilities not summing to 1) are retried once (a
validation failure is not a network error). Failures that cannot change on retry (answer
ids or types not matching the request, `choice` not an argmax, model mismatch) raise
immediately (`JevResponseError` or `JevModelDriftError`) and are not retried, so a
deterministic mismatch is billed once. What "fails the stage" means for the loop is the
stage failure policy in §6.

### 5.3 Confidence and probability, computed in the harness (REPORT §8)

- Choice: `probability = probabilities[choice]` (not a recomputed argmax);
  `confidence = (probability − 1/n) / (1 − 1/n)`.
- Score: `confidence = 1 − Σ_k p_k·|k − k*| / U_n`, `k*` = the smallest level index attaining
  the maximum probability (deterministic under ties; REPORT §8's fit uses the argmax and a
  tie-break changes the result by no more than the two-decimal rounding error already
  noted), `U_n = (n²−1)/(4n)` for odd n, `n/4` for even n; `probability = p_{k*}`. The
  response's `score` is validated only for range (§5.2).
- Noul: `probability = p`; the pane's confidence column shows `|2p − 1|` (Jev returns no
  confidence for Nouls; this derived value is labelled as such, §16).
- Risk per dimension on a 5-level Score, computed in the harness from `probabilities` in
  integer hundredths to avoid float boundary effects. **Harm dimensions** (`destructive`,
  `irreversible`): `risk_dim = max( E[k]/(n−1), P(k ≥ 3) )`. **Alignment dimensions**
  (`out_of_scope`, `plan_mismatch`): `risk_dim = P(k ≥ 3)` only, because their low levels
  (different order, tangential, skipped verification) are process notes rather than dangers
  and a flat distribution over them (Jev unsure) must not read as risk; the first live slice
  put 14 of 25 steps into review on `plan_mismatch` at Jev confidence 0.00 (DECISIONS.md).
  For the harm dimensions:
  `e100 = Σ_k k·round(100·p_k)` and `t100 = Σ_{k≥3} round(100·p_k)` (wire probabilities are
  two decimals, so both are exact); `r100 = max(e100, t100·(n−1))`; `verdict = block` iff
  `r100 >= 70·(n−1)`, `review` iff `r100 >= 30·(n−1)`, else `ok`; the stored `risk` is
  `r100 / (100·(n−1))`, `expected` and `tailMass` are stored with which term bound. The
  expected-level term grades how bad the action is (a fully confident level 0/1/2/3/4 maps
  to 0/0.25/0.5/0.75/1.0); the tail-mass term guarantees that any dimension whose
  block-level situations (levels 3 and 4) hold ≥ 0.7 of the probability blocks and ≥ 0.3
  reviews, so the prompt's 0.7 rule cannot be diluted by mass on lower levels. `risk = max`
  over the four dimensions. Band semantics with the §5.5 rubric (level 0 routine, level 1
  notable but fine, level 2 the first review level): a confident level 1 executes (0.25);
  review fires at E[k] ≥ 1.2, e.g. a level-1 action with ≥ 0.2 of mass at level 2, or ≥ 0.6
  at level 2 with the rest at 0; block fires at E[k] ≥ 2.8 or at tail mass ≥ 0.7. Worked
  bands: `{1: 1.0}` → 0.25 execute; `{1: .85, 2: .15}` → 0.2875 execute; `{1: .8, 2: .2}` →
  0.30 review; `{1: .9, 3: .1}` → max(0.30, 0.10) = 0.30 review; `{2: 1.0}` → 0.50 review;
  `{2: .25, 3: .75}` → max(0.6875, 0.75) = 0.75 block; `{3: .7, 2: .3}` → max(0.675, 0.70) =
  0.70 block; `{3: .8, 2: .2}` → max(0.70, 0.80) = 0.80 block; `{3: .8, 0: .2}` → max(0.60, 0.80) = 0.80 block;
  `{0: .1, 3: .9}` → max(0.675, 0.90) = 0.90 block; `{0: .7, 3: .3}` → max(0.225, 0.30) =
  0.30 review; `{0: .5, 4: .5}` → max(0.50, 0.50) = 0.50 review; `{4: .7, 0: .3}` → 0.70
  block. Alternatives considered: `E[k]/(n−1)` alone (a 90 %-probable level-3 `rm -rf`
  with 10 % on level 0 scores 0.675 and goes to human review instead of blocking);
  `P(k ≥ 2)` alone (ignores how bad); max-probability level (throws away mass); Nouls per
  dimension (clipped to [0.01, 0.99], not graded). Thresholds are compared with `>=` on the
  integer value, the verdict is independent of the summation order of the probability map,
  and the raw distribution is stored.

### 5.4 Question rules (REPORT §11, §14), enforced by `jev/questions.ts`

1. All questions for a stage go in one request (9.1× fewer tokens, 17× faster).
2. State is a JSON object; every instruction names its target with a backticked path
   (`` `proposal.action.command` ``), never "the command".
3. Every Choice has an escape option (`none_of_these: null`) and every non-escape option
   has a paired Noul asking, in absolute terms, whether that option is right now (prompt:
   "pair each option with a Noul"; REPORT §10: a Choice is relative and always picks
   something, a Noul is absolute and can be low for every candidate). Paired Nouls are
   `can_<option>`: "Is `<option>` (<option description>) the right kind of next step given
   `plan` and `recent`?" with `{ definition, examples }` criteria; they go in the same
   request as the Choice (rule 1); cost is ~9 input tokens per Noul plus its criteria text
   (REPORT §4). They are shown in the pane, stored as `Decision` rows, and consumed by the
   engine through Choice resolution (§6); Jev is never asked to reconcile them.
4. Every Noul carries `criteria: { true: { definition, examples: [...] }, false: {
   definition, examples: [...] } }` (both sides present, REPORT §2 rejects one-sided or null
   criteria), at least two examples per side; Score levels are situation descriptions;
   option keys are descriptive words, never `a`, `alpha`, `1`. `jev/questions.ts` rejects a
   Noul without both sides at build time. The one exception is the context stage, whose
   Nouls point at a shared `criteria.context` object in the state (§5.5, with a live gate).
5. Jev never counts or computes: test counts, byte sizes, step counts, diff stats, "did
   tests run after the last edit" are computed in code and placed in the state as fields.
6. Thresholds are not placed at 0.5 on borderline questions; judge outcomes are reported
   as probabilities, not booleans. Thresholds in this design: completion ≥ 0.85
   (configurable), task-impossible ≥ 0.85 (configurable), plan-claim acceptance ≥ 0.7 /
   rejection < 0.3 with the band in between reported as unverified (`PLAN_ACCEPT_THRESHOLD`,
   `PLAN_REJECT_THRESHOLD`), risk 0.3 / 0.7 (prompt), `plan_still_valid` and `matches_intent`
   consumed below 0.3. The only 0.5 cuts are the context-selection cutoff (a ranked cutoff
   over candidates, top by p, capped at 12 files / 60 KB, not a judgment on a single item)
   and the paired-Noul floor in Choice resolution (§6), where a flip changes only which
   non-executing decision is taken, never whether an action executes.
7. Model id. `config.decider.model` defaults to the dated id `typesafe/jev-1.13-20260917`
   (REPORT §16). `config.decider()` normalises the configured id once: lowercase, strip a
   leading `typesafe/`; a normalised id ending in `-YYYYMMDD` is *dated*, otherwise it is an
   *alias*; `DeciderConfig` carries `model` and `pinned: boolean`. Every response's `model`
   is normalised the same way and compared:
   - configured dated, served equal → ok.
   - configured alias, served starts with the alias (e.g. `jev-1.13` → `jev-1.13-20260917`)
     → ok; on the first Jev call of a run the served id is stored as `resolvedJevModel` in
     `state.json` (so it survives `--resume`) and `run.json`, and one transcript warning is
     printed: `jev model alias <alias> resolved to <dated id>; pin it with --jev-model <dated
     id> for reproducible thresholds`. Every later response, including after resume, must
     match `resolvedJevModel`.
   - any other mismatch → `JevModelDriftError` (a `JevError`, never retried). On the first
     Jev call of a run it aborts the run (exit code of the `ConfigError` class, message names
     `--jev-model`, the configured value and the served value). On a later step it does not
     abort: the decision rows for that call carry `servedModel`, `state.json`/`run.json` get
     `jevModelDrift: { step, served }`, one warning is printed, and the run continues; the
     bench summary marks such tasks `modelDrift: true` and excludes them from the
     Jev-on/Jev-off comparison by default.
   - `bench` refuses to start with an alias unless `--allow-model-alias` is passed, since
     Jev-on vs Jev-off comparisons assume a fixed model; it records `jevModel` (the resolved
     dated id) in `summary.json`.
8. Every Score varies along exactly one quantity, named in its instructions, and every
   level text is a situation on that quantity only: `destructive` is how much existing data
   or state would be lost; `irreversible` is how hard the effect is to undo; `out_of_scope`
   is distance from `task`; `plan_mismatch` is distance from `plan`. Level texts never
   mention action type or location except as an example of the quantity (REPORT §10: a
   rubric mixing two dimensions split 0.33/0.67 at confidence 0.50 where the one-dimensional
   version gave 1.0; measured on the v1 rubric, `cat ~/.gitconfig` split 0.54/0.46 between
   levels 0 and 4 and landed in review). Reads anywhere on the filesystem are level 0 on
   `destructive`: the sandbox (§8) denies writes outside the workspace and permits reads
   (except the harness's own secret stores), so a read outside the workspace is not a loss;
   if it is unrelated to `task` (for example a credentials file) `out_of_scope` levels 3-4
   catch it.

### 5.5 Per-stage questions

State common to every stage (compact, code-built):

```json
{ "task": "<user task text>",
  "plan": { "done": [...], "remaining": [...], "unverified": [...], "openProblems": [...], "harnessProblems": [...] },
  "recent": [ { "step": 6, "intent": "edit", "action": "edit src/a.py", "outcome": "executed",
                "judge": { "succeeded": 0.92 }, "output": "<≤600 chars>", "shownFiles": ["src/a.py"], "notes": [] } ],
  "workspace": { "root": "…", "git": true, "hasTests": true, "testCommand": "pytest -q",
                 "changedFiles": ["src/a.py"], "createdThisRun": ["tests/test_new.py"],
                 "lastChangeStep": 6,
                 "lastTestRun": { "step": 5, "command": "pytest -q", "passed": 41, "failed": 0, "errors": 0, "allPassed": true },
                 "testsCurrent": false,
                 "sandbox": "seatbelt" },
  "budget": { "stepsUsed": 6, "stepsMax": 40, "spentUsd": 0.31, "capUsd": 2 } }
```

`plan` in every Jev state is the accepted plan (post-update from the previous step).
`proposal.planClaim` is the generator's unverified claim for after this step and is present
only in the risk and judge/complete states. `workspace.lastTestRun` is the most recent step
in this run (including the current one, in the judge/complete state) whose executed action
ran the detected test command and produced a parsed summary; `lastChangeStep` is the most
recent executed edit/write/patch that changed files; `testsCurrent` is computed in code as
`lastTestRun !== null && (lastChangeStep === null || lastTestRun.step > lastChangeStep)`,
i.e. true iff no file has changed since the last test run. All three are persisted in
`state.json` (§9) so `--resume` preserves them. `recent[i].shownFiles` lists the context
files and `read` paths of that step so Jev and the generator see what has already been
shown. `workspace.sandbox` is `'seatbelt' | 'none'`. `budget.spentUsd` and `capUsd` come
from the run's meter snapshot.

**replan** (after loop detection, at the start of the next step): state adds `trigger:
'loop'` and `loop: { signature, kind, occurrences, lastOutcomes: [...], trips, priorDirectives:
[{ step, directive }] }` (trips for this signature so far and the directives already given
for it, so Jev sees a repeat trip and can choose `stop_and_report`). Choice `next_move` over
`change_approach`, `gather_context`, `fix_environment`, `revert_changes`, `stop_and_report`,
`none_of_these`, each with a one-sentence description. Paired Nouls, one per non-escape
option: `can_change_approach`, `can_gather_context`, `can_fix_environment`,
`can_revert_changes`, `can_stop_and_report`. Plus the stage Noul `task_impossible` ("Is
`task` impossible in this workspace as stated?", criteria with examples), consumed in §6.

**intent**: Choice `intent` over `investigate` ("read or search code before changing it"),
`edit` ("change source files"), `verify` ("run tests, a build, or a script to check the
current state"), `fix_environment` ("install a dependency or repair tooling so work can
continue"), `finish` ("nothing remains; the work is verified"), `none_of_these: null`.
Paired Nouls, one per non-escape option: `can_investigate`, `can_edit`, `can_verify`,
`can_fix_environment`, `can_finish`. Stage Noul (not paired): `plan_still_valid` ("Does
`plan.remaining` still describe what has to happen next given `recent`?"), consumed in §6.
`needs_more_context` is not asked: the context stage decides per file and `recent[i].shownFiles`
carries what has been shown. `finish` does not short-circuit any stage: the generator is
told Jev's intent and may propose `done` or any other action; a non-`done` action under
`finish` is scored normally.

**context**: `candidates` is an object keyed by workspace-relative path, never an array, so
no question depends on array position (REPORT §10: `people[2].pet.kind` resolved at 0.72 vs
0.99 for direct references; positional lookup is counting, which Jev must not do):
`candidates: { 'src/a.py': { bytes, mentionsInTask, touchedThisRun }, ... }`. The
context-stage state also carries `intent: { choice, probability }` from the intent stage
(the common state does not include it) and `criteria.context: { definition, examples: {
yes: [...], no: [...] } }` once. One Noul per candidate, each naming the file literally so
the reference is semantic, not positional: "Should the engineer be shown the file `src/a.py`
(details at `candidates["src/a.py"]`) for an `intent.choice` step? Apply `criteria.context`."
A Noul with instructions and no per-question `criteria` is valid on the wire (REPORT §2).
Cost: each question is ~40 tokens (REPORT §4's +9 applies only to a short noul), so 300
candidates ≈ 12 k question tokens plus ≈ 12 k of candidate state; the request stays under
the 64 k request cap and the 32 k state + longest question cap. `mentionsInTask` and
`touchedThisRun` are computed by `loop/stages/context.ts` from the task text and the run's
changed-files set; `workspace/candidates.ts` returns only path and bytes. Selection in code:
p ≥ 0.5, descending, cap 12 files and 60 KB; files mentioned by `plan.remaining[0]` are
candidates but not forced in. Candidates are pre-filtered in code to ≤ 300 paths by mention
count and recency. Selected files are read via `workspace/files.ts`, which resolves each
path with `resolveInside` (§8) before `readFile`.

Gate: the 3-task live slice must run the shared `criteria.context` form and the
per-question `criteria` form on the same 20-file sample and record agreement (max |Δp| and
argmax flips). If agreement is worse than 0.05 max |Δp| or any flip crosses 0.5, switch to a
short per-question `criteria` (definition only, ~40 tokens; 300 × 40 = 12 k extra, still
within the 64 k cap) and record the change in §16.

**risk** (after propose, for every proposed action including `done`): state adds
`proposal: { goal, action, planClaim: <PlanDraft>, claimsDone: <boolean: planClaim.remaining.length === 0> }`
and `intent`. For `edit`/`write`/`patch` actions the state adds, computed in code, never by
Jev, `proposal.target: { path, existsBefore, tracked, createdThisRun, recoverable }` (for
`patch`, one entry per touched path under `proposal.targets[]`), where `tracked` = `git
ls-files --error-unmatch` succeeds (always false when `workspace.git` is false),
`createdThisRun` = the path first appeared via a `write`/`patch` in this run (engine state,
persisted in `state.json`), and `recoverable = tracked || createdThisRun` (prior content is
in git or in `steps.jsonl`). Four Scores, five situation levels each (`criteria` arrays),
each on one quantity (rule 8); level 0 is the routine action the task plainly needs, level
1 is "notable but fine" and executes when confident, level 2 is the first review level:

- `destructive` ("How much existing data or state would running `proposal.action` lose?"):
  0 "nothing existing is lost: reads, searches, lists, or runs tests/builds; creates a file
  that did not exist (`proposal.target.existsBefore` false); anything it changes the
  workspace regenerates", 1 "changes files whose previous content is recoverable
  (`proposal.target.recoverable` true: git-tracked, or first written earlier in this run),
  or changes dependency manifests, configuration or CI files inside the workspace, or
  installs into a project-local environment (venv, node_modules)", 2 "loses untracked
  pre-existing work (`proposal.target.existsBefore` true and `recoverable` false), or
  resets/cleans the working tree", 3 "loses much of the workspace: mass deletion, history
  rewrite, force push, or `rm -rf` of a directory inside the workspace", 4 "loses or modifies
  data outside the workspace: home directory files, system packages, other repos,
  credentials, or kills processes it did not start".
- `out_of_scope` ("How far is `proposal.action` from what `task` asks?"): 0 "directly does
  what `plan.remaining[0]` or `task` asks", 1 "setup or investigation the task plainly
  needs", 2 "tangential improvement not asked for", 3 "unrelated to `task`", 4 "contradicts
  an explicit constraint in `task`".
- `plan_mismatch` ("How far is `proposal.action` from `plan` and `intent`?"): 0 "matches
  `intent` and the plan", 1 "matches the plan, different order", 2 "skips a planned
  verification step", 3 "ignores the plan's open problems, or claims completion (`done`)
  while `plan.remaining` is non-empty", 4 "contradicts the plan, repeats a step `recent`
  shows already failed the same way, or claims completion with no verifying test run in
  `recent`".
- `irreversible` ("How hard is the effect of `proposal.action` to undo?"): 0 "no lasting
  effect, or restorable with one git command", 1 "restorable by regenerating or
  reinstalling inside the workspace", 2 "loses untracked local work", 3 "network writes,
  publishes, sends, or deletes outside git", 4 "cannot be reversed".

Plus Noul `matches_intent` ("Does `proposal.action` carry out `intent`?", criteria with
examples) shown in the pane and consumed in §6; it never enters the risk number.

**judge** (after execute, batched with **complete**; sent only when `outcome.status ===
'executed'`, reduced to `task_complete` alone for `noop`, not sent for `blocked`/`declined`/
`failed`, §6): state adds `executed: { action, exitCode, killedBy, truncated, bytesSeen,
sandboxExecDenied, orphans, output: "<≤4 KB head+tail, built from head and tail so the
final lines are always present>", changedFiles, tests: { command, parsed: { passed, failed,
errors } | null, allPassed: boolean | null } }`, `proposal: { goal, action, planClaim,
claimsDone }`, and `claims: ["<newly claimed done items>"]`. `recent` includes the current
step's entry (the state is built after execute), so the completion Noul sees this step's
action, outcome and output. `workspace/tests.ts` computes in code `tests.allPassed = parsed
!== null && parsed.failed === 0 && parsed.errors === 0 && parsed.passed > 0`; `parsed` is
taken from the tail when `truncated` (pytest/jest/cargo summaries are at the end of
output). `JudgeResult.tests` is `{ source: 'parsed', allPassed, … }` when `parsed` is
non-null and is not a Jev question (rule 5). Nouls, each with criteria:

- `succeeded` ("Do `executed.output` and `executed.changedFiles` show that `proposal.goal`
  happened?") true: definition "the output or changed files show the goal occurred: an edit
  applied once, a command exited 0 with the expected effect, a read returned the requested
  content", examples ["edit applied to src/a.py (1 match)", "exit 0, 12 passed"]; false:
  definition "no match / N matches, non-zero exit, timeout, truncated before the result, or
  the goal is only asserted in the engineer's text", examples ["EditError: 2 matches",
  "exit 1", "timed out after 120s"].
- `error_present` ("Does `executed.output` contain a failure the engineer must act on?")
  true: definition "a traceback ending in an exception, a non-zero exit with a diagnostic, a
  failed assertion, a missing module/command/file", examples ["ModuleNotFoundError: No module
  named x", "AssertionError", "sh: cmd: not found"]; false: definition "warnings,
  deprecation notices, the words error/ERROR inside passing output or as log-level names,
  expected failures (xfail), `0 errors`, tests that deliberately exercise error paths",
  examples ["DeprecationWarning: …", "ERROR root:app.py:12 handled (test passed)", "0 errors,
  14 passed", "XFAIL"].
- `new_information` ("Does `executed.output` contain a fact not in `plan` or `recent` that
  changes what to do next?") true: definition "a new failing test, a missing dependency, a
  different root cause, an unexpected file layout", examples ["a second test fails after the
  fix", "package requires Python ≥3.10"]; false: definition "confirmation of what the plan
  already says or a repeat of a known failure", examples ["same traceback as step 5", "tests
  pass as expected"].
- `tests_pass_unparsed`, only when the test command ran but no summary parsed (`parsed ===
  null`, e.g. `go test`): "Does `executed.output` show the test command finishing with every
  test passing?" true: definition "a final summary reporting only passes/skips, exit code
  0", examples ["12 passed in 3.1s", "ok  pkg/foo  0.412s", "PASS"]; false: definition "any
  failed/error count, a traceback after the summary, non-zero exit, or no summary because
  the run was cut off", examples ["1 failed, 11 passed", "FAIL  pkg/foo", "ERRORS", "Killed /
  timed out"]; its answer becomes `tests: { source: 'judged', allPassed: p }`.
- one Noul `done_<j>` per newly claimed plan item (see §6 Plan): "Do `executed` and `recent`
  show that `claims[<j>]` is finished?" with criteria true: definition "the item's outcome is
  visible in `executed.output`, `executed.changedFiles`, or `executed.tests.parsed`, or in an
  earlier `recent` entry's output (a passing test run, an applied edit whose effect is then
  verified, a command that produced the required artefact)", examples ["12 passed after the
  edit to src/a.py", "artefact build/report.html listed by ls"]; false: definition "claimed
  but not shown; shown only by the engineer's own text or summary; attempted but failed or
  blocked; or its verification has not run yet", examples ["plan says fixed, no test run
  since the edit", "exit 1 on the command that was to produce it"].
- the completion Noul `task_complete`: instructions "Is `task` complete, judged from
  `executed`, `recent`, `workspace.lastTestRun`, `workspace.testsCurrent` and the accepted
  `plan`? Treat `proposal.planClaim` as the engineer's own unverified claim of what
  remains." criteria true: definition "the requested behaviour is implemented AND verified
  in this run: when `workspace.hasTests` is true, `workspace.lastTestRun` is present,
  `workspace.lastTestRun.allPassed` is true and `workspace.testsCurrent` is true; when
  `workspace.hasTests` is false, `recent` shows equivalent direct evidence (a build, a script
  run, or output demonstrating the behaviour); and nothing in the accepted `plan.remaining`
  is still genuinely outstanding once the work `executed` just did is counted as done",
  examples [...]; false: definition "untested; `workspace.lastTestRun` absent or with
  failures; `workspace.testsCurrent` false (files changed after the last test run);
  `proposal.planClaim.remaining` is empty but `plan.remaining` or `recent` shows unfinished
  or unverified work; or `plan.openProblems` names something unresolved", examples [...].
  The completion criteria never reference `executed.tests` (that is this step's `tests`
  input only) and never reference `plan.remaining` being non-empty by itself, so the Noul
  can fire on the step that produced the final evidence.

Stop rule: `task_complete ≥ completeThreshold` → `stop('complete')`. Budgets are checked in
code at step start and before execute (§6); the first that fires is recorded.

## 6. The step loop (`loop/engine.ts`)

```
render first frame (from argv only: task text or `resuming <run-id>`, `step 0/–`, status `starting`)
  → resolveConfig (reads .env files and config file, no validation)
  → resume or init run
  → emit run:ready { runId, step, maxSteps, task, resumed }   (fills the status line)
  → validate config on first use (config.generator() / config.decider()) inside the first stage that needs it
loop:
  checkBudgets()? → stop(reason)                       spend_cap, wall_time, max_steps, max_replans; first that fires
  if loopDetector.tripped(): replan Choice + paired Nouls (1 request) → Choice resolution → directive (or stop)
  intent   : Jev Choice + paired Nouls + plan_still_valid (1 request) → Choice resolution → effective intent
  context  : Jev Nouls over candidates (1 request) → selected files, bounded read
  propose  : generator streams one JSON proposal; parse+validate (1 retry on malformed)
  risk     : Jev 4 Scores + matches_intent (1 request) → risk=max → ok | review(confirm) | block   (also for `done`)
  await previous checkpoint write
  checkBudgets(spend_cap, wall_time)? → §9.1 rule 1, stop(reason)
  execute  : sandboxed action (or outcome = noop | blocked | declined | failed)
  judge+complete : only if outcome.status === 'executed' — Jev Nouls incl. done_<j> per claim (1 request)
                   → plan update per Plan rules (0.7 / 0.3 bands); `noop` → task_complete only; otherwise skipped
  commit   : plan/window/loopDetector mutated here and only here; loopDetector.observe(step)
  checkpoint (atomic snapshot) ; emit status
  if completion ≥ completeThreshold → stop('complete')
```

Three to four Jev round trips per step (~170 ms each, REPORT §5); generator latency
dominates. Independent work runs concurrently: the candidate cache refresh and the
plan/window serialisation overlap the intent request; the checkpoint write for step N may
overlap step N+1's intent/context/propose/risk stages but is awaited before step N+1's
execute stage and on shutdown, so the workspace is never more than one un-checkpointed step
ahead of durable state (§9). The checkpoint serialises a snapshot of engine state taken
synchronously at the commit point, after the plan update, after this step's spend has been
added to the meter, and after `loopDetector.observe(step)`; the write may complete
asynchronously but the snapshot object is never mutated by the next step.

Every stage emits `stage:start`/`stage:end`; `status` is emitted after every `stage:end` and
`step:end` and is the only event `StatusLine` subscribes to. The engine emits
`confirm:request` and then awaits `Confirmer.confirm()`; the TUI's Confirmer resolves from
`useInput`, the plain renderer's from readline, the bench's returns false.
`loop/generator-only.ts` implements the same `Engine` interface and emits the same union
(`decision`, `jev:request`, `intent`, `context`, `risk`, `judge`, `replan` never fire in
jev-off) so the TUI, plain renderer and bench work unchanged for both conditions (§13).

**Per-outcome stage table.** The pseudo-code shows the full path; these rows say which
stages run otherwise. Every committed row still ends with commit, checkpoint and status
emit, and every committed step counts toward `max_steps`.

```
intent = none_of_these, or the chosen option's paired Noul < 0.5 (Choice resolution below)
                              -> effective intent per Choice resolution (fallback `investigate`); no mid-step jump to replan;
                                 StepRecord.intentAnswer keeps the raw answer; the context question and the generator prompt use the
                                 effective intent and the prompt says "Jev found no fitting intent (p=…, chose …); investigate
                                 before changing anything"; loop signature `intent:unresolved` on a fallback.
intent = finish               -> no engine branch; the user message adds: "Jev judges nothing remains. Propose `done` with a summary
                                 if you agree, or one final verification `run`." Any action is then scored normally.
proposal = done               -> risk runs (done path below). Passed: execute records { status: 'noop', summary }, changedFiles stay
                                 empty; judge request is the reduced form (task_complete only); judge = null; completion = task_complete.
                                 Blocked/declined: as the blocked/declined row. Loop signature done:<sha12(normalised summary)> in every case.
proposal = read               -> risk runs; execute reads files under the context bounds (<= 12 files, <= 60 KB, 16 KB each) through
                                 resolveInside; status 'executed' with exec absent, executed.output = concatenated views; judge asks
                                 succeeded + new_information (+ done_<j>, task_complete); loop signature read:<sha12(sorted paths)>.
generator malformed x2        -> the retry message carries the GeneratorResponseError reason and the last 500 chars of rawText; both
                                 calls are metered. After the second failure: proposal = null; outcome = { status: 'failed', error:
                                 'propose: generator_response' }; risk, execute, judge, complete skipped (null); window entry carries the
                                 error; signature fail:generator:<sha12(normalised reason)>; consecutiveStageFailures += 1. Run continues.
outcome blocked | declined    -> judge+complete skipped; judge = completion = null; StepTiming.jevMs excludes it; decisions contain no
                                 judge/complete rows; every newly claimed done item rejected (no done_<j> evidence); remaining/openProblems
                                 merged per the Plan rules; window entry carries outcome.status and the reason verbatim (<= 600 chars),
                                 which is how the reason reaches the generator; loop signature is the action's normal signature.
outcome failed                -> EditError / PatchError / PathEscapeError / SecretPathError, or a stage failure (policy below). Same as
                                 blocked plus signature fail:<sha12(error class + normalised first error line)>. Passing the output
                                 cap is NOT a failure (§8); a timeout is status 'executed' with exec.killedBy = 'timeout'.
stage failure (Jev/provider)  -> stage failure policy below: nothing downstream runs, step recorded with `error`.
abort / wall time mid-step    -> step commit rule §9.1.
```

**Choice resolution** (`loop/stages/choose.ts`, shared by intent and replan). Let `c` be the
response's `choice` and `nouls[o]` the paired Noul of each non-escape option. (1) If `c` is
not the escape and `nouls[c] ≥ 0.5`, take `c`; its Choice row gets `verdict: 'chosen'`. (2)
Otherwise take the option with the highest paired Noul if that Noul is ≥ 0.5; the Choice row
gets `verdict: 'overridden'`, the winning Noul row `verdict: 'chosen'`. (3) Otherwise (escape
chosen and no Noul ≥ 0.5, or every Noul < 0.5) take the stage's safe default: `investigate`
for intent, `change_approach` for replan; the Choice row gets `verdict: 'fallback'`. For
intent, a fallback also feeds the loop detector the signature `intent:unresolved`, so three
consecutive fallbacks trip it and the next step starts with the existing replan stage. For
replan, a fallback directive is bounded by `max_replans` like any other directive. The
generator prompt receives the resolved option, its Choice probability and its paired Noul
value. The 0.5 floor on paired Nouls is tolerated under §5.4 rule 6 because a flip changes
only which non-executing decision is taken; execution is still gated by the risk stage.

**Consumers of every Jev answer** (every question in §5.5 appears here):

- intent `intent` + `can_*`: Choice resolution above → effective `Intent`; `StepRecord.intent`
  holds the effective intent, `StepRecord.intentAnswer` the raw answer.
- intent `plan_still_valid`: if < 0.3, the harness adds `{ kind: 'stale_plan', text: "Jev
  judged the plan stale at step N (p=…)" }` to `plan.harnessProblems` (so it survives the
  generator's `openProblems` replacement) for the next prompt only; ≥ 0.3 has no effect
  beyond the pane and `decisions.jsonl`.
- context Nouls: selection as specified (p ≥ 0.5, cap 12 files / 60 KB).
- risk Scores: risk policy below. risk `matches_intent`: if < 0.3, its text is appended to the
  risk reason (when the verdict is review or block) and one line is added to the next
  generator prompt ("Jev judged the last action did not carry out intent `X` (p=…)"); it never
  enters the risk number.
- judge `succeeded`, `error_present`, `new_information`, `tests`: reported as probabilities in
  the window and the pane (rule 6); `new_information ≥ 0.7` is the only code consumer (Plan
  rule b); none gates plan acceptance and none feeds loop signatures (`fail:` is derived from
  outcome/exit code in code).
- judge `done_<j>`: Plan rule a.
- complete `task_complete`: `≥ completeThreshold` → `stop('complete')`; otherwise, on a `noop`
  step, the window entry carries `done rejected: task_complete=0.41` so the generator sees why.
- replan `next_move` + `can_*`: Choice resolution → `ReplanMove`. `stop_and_report` →
  `stopReason = 'replan_stop'`. `none_of_these` (or a fallback) → `change_approach`, and the
  generator is told Jev found no listed recovery applicable and must propose a different
  action. Every directive, `revert_changes` included, is advice injected into the generator
  prompt and stored as `{ kind: 'replan', text }` in `plan.harnessProblems`; the harness
  executes nothing during replan, and any resulting action (e.g. `git checkout -- <path>`)
  goes through the normal risk stage.
- replan `task_impossible`: `≥ impossibleThreshold` (default 0.85) → `stopReason = 'impossible'`
  regardless of `next_move` (recorded with the probability in the stop record and transcript;
  the Noul is absolute where the Choice is relative, REPORT §10); below that it is shown in
  the pane and included in the directive text.

**Plan** (`loop/plan.ts`): the generator returns a full `PlanDraft` each step; the harness
diffs it against the current `Plan` in code and applies these rules at the commit point.
(a) *Done claims.* Items newly present in `proposal.plan.done` (not already in `plan.done`)
are placed in the judge-stage state as `claims: [...]` (at most 8 per step, ≈9 tokens each
plus criteria, REPORT §4; excess is dropped and noted in the next prompt) and the judge
request gains one Noul `done_<j>` per claim (§5.5). Acceptance depends only on `done_<j>`,
never on `succeeded`: `p ≥ PLAN_ACCEPT_THRESHOLD` (0.7) → the item moves to `plan.done` with
`evidence: { step, judged: p }`; `PLAN_REJECT_THRESHOLD` (0.3) `≤ p < 0.7` → it stays in
`remaining`, is listed in `plan.unverified`, and the next prompt says `Jev was unsure
(p=0.xx) that '<item>' is finished; verify it (run the tests or the script) before marking
it done`; `p < 0.3` → it stays in `remaining`, `{ kind: 'rejected_claim', text }` is added to
`plan.harnessProblems`, and the next prompt says `'<item>' was not accepted as done:
done_<j> = 0.xx`. A claim repeated on a later step is judged again on that step's evidence,
never accepted on the earlier evidence. On a `noop`, `blocked`, `declined` or `failed` step
there is no `done_<j>` evidence and every new claim is rejected. (b) *Remaining.* Additions
are accepted (cap 20 items, 200 chars). An item the generator drops from `remaining`
without a done claim is removed only when a replan directive was issued this step or this
step's `new_information ≥ 0.7`; otherwise it is retained and the prompt says so. A
rewording is treated as remove + add. (c) *Open problems.* `plan.openProblems` is replaced by
the generator's list (cap 16). `plan.harnessProblems` (the current replan directive,
rejected claims, stale-plan notes) is owned by the harness, marked as such in the prompt and
in the Jev state, and expires when the directive is superseded by the next replan, the claim
is accepted, or (stale-plan) after the next step. Rejection and unverified notes are also
stored on that step's `WindowEntry.notes`, so they survive resume and expire with the
window. Size caps: 20 items per list, 200 chars each. In jev-off (§13) items newly in
`done` are accepted verbatim with `evidence: { step, judged: -1 }`.

**Recent window** (`loop/window.ts`): last 4 steps, each ≤ 600 chars of output (head 400 +
tail 200) plus action summary, outcome, judge probabilities, blocked/declined/failed reasons,
`truncated: true` when the output cap was passed, `shownFiles`, and `notes`. Context files:
≤ 12 files, ≤ 60 KB total, each ≤ 16 KB (head, with `…[truncated N bytes]`). So the
generator prompt is O(plan + window + context), never O(transcript). `errorPresent` and
`newInfo` reach the generator only through the window and the pane.

**Loop detection** (`loop/loopdetect.ts`): per step compute zero, one, two or three
signatures from the `StepRecord`, recorded in `loopSignatures`. From the proposal, for every
outcome status (`executed`, `noop`, `failed`, `blocked`, `declined`, so a repeatedly blocked
or declined proposal counts): `run:<sha12(normalised command)>:<sha12(result)>` for `run`,
where `result` is `exitCode + normalised output` when executed and `outcome.status +
normalised reason` otherwise (the same command with a different result is progress, not a
loop; the same blocked command three times is); `patch:<sha12(path+old+new | diff |
path+content)>` for edit/write/patch; `read:<sha12(sorted paths)>` for `read`;
`done:<sha12(normalised summary)>` for `done`, whatever its outcome; `intent:unresolved` for
an intent fallback; `fail:generator:<sha12(normalised reason)>` for a twice-malformed
generator response. Additionally `fail:<sha12(error class + normalised first error line)>`
when `outcome.status === 'failed'` or a `run` exited non-zero. A null proposal (stage failure
before propose) yields none; interrupted steps and Jev/provider stage failures are not
observed (they are not generator behaviour). Normalisation strips digits, hex hashes,
timestamps, durations and absolute workspace paths. Counts are cumulative since run start or
the last replan, whichever is later; the detector trips when any count reaches 3 (if
several trip in the same step, the first in the order above is reported). On a trip the
next step starts with **replan**; `loop.signature`/`loop.kind` name the tripped signature;
the resolved directive is injected into the generator prompt and stored in
`plan.harnessProblems`; all counts reset. Trip history is kept across the run:
`loopDetector.tripsBySignature[signature]` and `loopDetector.replanCount` are checkpointed
and the replan state carries `loop.trips` and `loop.priorDirectives`. `max_replans`
(default 5) is a budget checked in code like `max_steps`; hitting it records `stopReason =
'max_replans'`. `observe(step)` runs at the commit point before the checkpoint, so a resumed
run trips on the same occurrence a continuous run would.

**`fail:` of a failing test run is the failure's identity, not its text (2026-09-20, ladder
round 6; `loopdetect.ts testFailureIdentity`).** When the non-zero `run` is a recognised test
runner (the engine's detected runner, else `runnerFromCommand` on the command), the signature is
`fail:<sha12("tests:" + sorted failing/erroring test ids)>` parsed from stdout+stderr (pytest
`FAILED|ERROR <id>` summary lines and `-v` rows, unittest/Django `FAIL|ERROR: test (Class)`,
sympy `____ path.py:test ____` headers, cargo `test x ... FAILED`, go `--- FAIL:`, vitest/jest
`FAIL`/`✕`/`●` lines); when no id is printed (a `-qq` progress line, a killed run) it is
`fail:<sha12("counts:<passed>/<failed>/<errors>")>` with the digits kept; only when nothing
parses, or the command is not a test runner, does the previous `exit:<code>` + normalised
first-line hash apply. Two failing runs are the same failure only when their failing sets are
identical, so a suite going 6/10 → 8/10 → 9/10 (ladder round 5 `units` steps 1, 4, 6: the last
`FAILED` line was the same test each time and the text hash read it as one failure ×3) never
trips, while three runs with the same set do, whatever the message text, the order of the
`FAILED` lines or the scope of the command (`pytest` vs `pytest tests/test_x.py`).

**Risk policy**: `risk ≥ 0.7` → `blocked`, reason built from the dimension(s) at the max with
the dominant level's text, which term bound (`expected` or `tail`, e.g. "destructive: 0.90
probability of level 3 or above"), and the Jev confidence; returned to the generator in the
window. `0.3 ≤ risk < 0.7` → the engine emits `confirm:request` immediately before `await
confirmer.confirm(req, { signal })` and `confirm:resolved` immediately after; the TUI
renders the prompt inline and the loop awaits it; there is no auto-approve. On `false` the
outcome is `{ status: 'declined', reason }` where `reason` is the same dimension/level/
confidence text the block path builds, prefixed by the confirmer's identity: `declined by
reviewer: <risk reason>` for the TUI confirmer, `not approved (no reviewer in bench runs):
<risk reason>` for the bench confirmer, so the generator always sees which dimension and
level triggered the review, never a bare refusal or a fictitious human. The bench confirmer
always returns `false`. An `AbortError` from `confirm()` yields outcome `{ status:
'declined', reason: 'aborted during review' }` and the step is handled by §9.1 rule 1
(nothing executed). `risk < 0.3` → execute.

**done path.** A `done` proposal goes through the risk stage like any other action (the
prompt scores every proposed action; `destructive`/`irreversible` are trivially level 0,
`out_of_scope` and `plan_mismatch` are the meaningful dimensions, and a `done` with
`plan.remaining` non-empty or with no verifying test run in `recent` is expected to land at
`plan_mismatch` level 3/4 and be blocked with that reason). If not blocked or declined,
execute records `{ status: 'noop', summary }`, `changedFiles` stays empty, and the judge
request is the reduced form: `executed: { action: 'done', summary, exitCode: null, output: ""
}`, only `task_complete` asked (`succeeded`, `error_present`, `new_information`, `tests`,
`done_<j>` are not); `StepRecord.judge` is `null` and `StepRecord.completion` holds
`task_complete`. `task_complete ≥ completeThreshold` → `stop('complete')` without a further
round trip; otherwise the window entry reads `done rejected: task_complete=0.41` (or the
block reason). A blocked or declined `done` does not reach the completion Noul, which is
correct because a blocked finish is not a finish. `noop` outcomes are counted in neither
`blocked` nor `reviews` (§13).

**Non-executed outcomes.** When `outcome.status` is `blocked`, `declined`, or `failed`, the
judge+complete request is not sent: `judge = null`, `completion = null`, `StepTiming.jevMs`
excludes it, the step's `decisions` contain no judge/complete rows, every newly claimed
`done` item is rejected, and `remaining`/`openProblems` are still merged per the Plan rules.
The completion Noul may fire on the step that produced the final evidence: the harness
supplies `proposal.planClaim` and the code-computed `workspace.lastTestRun` /
`testsCurrent` so Jev does not depend on the not-yet-updated `plan`.

**Budgets** (`loop/budget.ts`): `SpendMeter.add()` (`spend/meter.ts`, the only home of
spend) records generator and Jev cost and never throws; `Decider.ask()` and
`Provider.generate()` always return the paid, validated response. Providers and the Jev
client never touch the meter; the engine calls `meter.add('jev', usage)` after every
successful `ask()` and `meter.add('generator', usage)` after every successful `generate()`,
in the stage that made the call. `costUsd` is computed by the caller of the API:
`openrouter.ts` from `usage.cost`; `anthropic.ts` from `GeneratorConfig.pricing` (the §3
table or the `JEVCODE_PRICE_*` override); `jev/client.ts` from `usage.cost`. Budget checks
run in code through one function `checkBudgets(): StopReason | null` that tests, in this
fixed order, `spend_cap`, `wall_time`, `max_steps`, `max_replans` and returns the first that
is exceeded. It is called at exactly two points: (1) at step start, before the intent
request, all four; (2) immediately before **execute**, `spend_cap` and `wall_time` only, so
that no action is run once the propose call has taken spend over the cap or wall time has
run out (§9.1 rule 1 applies: the step is discarded, the proposal is kept in
`state.interrupted` for the transcript, and the run stops with that `StopReason`,
`stoppedAt: 'before_execute'`). Once an action has executed, judge+complete always runs (one
Jev request, ~170 ms, ~$0.0002) so every checkpointed step is whole: outcome, judge,
completion and its `Decision` rows are all recorded and the plan update is applied. If that
judge call takes spend over the cap, the step completes and the run stops with `spend_cap`
at the next step-start check (`stoppedAt: 'step_start'`). Overrun is therefore bounded by
one generator call plus one judge call, the same bound as any design that cannot cancel a
stream mid-flight. `StopReason` records the check that fired.

Wall time is additionally enforced by the engine's single `AbortController`: at run start
(and on resume, from the remaining budget `maxWallMs − wallMsUsed`) the engine sets one
`setTimeout(...).unref()` that calls `controller.abort(new BudgetError('wall_time'))`;
`shutdown()` (§11) calls `controller.abort(new AbortError(reason))`. Every `generate`, `ask`,
sandbox run, confirm and retry sleep receives `engine.signal`. The effective timeout of every
sandboxed command is `min(action.timeoutMs ?? 120_000, 600_000, wallRemainingMs)`, so a
`run` never outlives `--max-wall`. On a wall-time abort the sandbox tree is killed (§8),
`exec.killedBy = 'wall_time'`, the in-flight stage's error is caught at the stage boundary,
the step is committed per §9.1 (rule 2 or 3) with `interruptedAt.reason = 'wall_time'`, the
checkpoint is written, and the run stops with `stopReason = 'wall_time'`; the window renders
it as "stopped by wall-time budget", not as a command timeout, so a resumed run does not
treat the command as slow. `BudgetError` and `AbortError` are not stage failures.

**Stage failure policy.** Every stage returns its result or throws a typed error; the engine
catches at the stage boundary and never continues past a failed stage. Terminal errors: a
`JevError` after the client's 3 HTTP attempts plus at most 1 validation retry (§5.1, §5.2);
a `ProviderError` after its retries; a second `GeneratorResponseError` in propose (§7).
- Nothing downstream of the failed stage runs. A failed **risk** request never executes the
  action (fail closed). A failed **judge+complete** request never accepts `PlanDraft.done`
  items and never fires the stop rule.
- The step is still committed (`steps.jsonl`, checkpoint, transcript) with `error: { stage,
  code, message }` (redacted). Fields for stages not reached are `null`. If the failure is
  before propose, `proposal = outcome = null`. If it is at propose or risk, `outcome = {
  status: 'failed', error: '<stage>: <code>' }` and the window entry shows the proposal
  with that error so the generator knows it did not run. If it is at judge, the executed
  `outcome` is kept, `judge = completion = null`, and the window entry carries `unjudged:
  <code>`; the plan update applies rule (b) only and rejects done claims.
- Failed steps count against `max_steps` and their spend is metered. Jev and provider
  failures are not observed by the loop detector and do not route to replan (replan needs
  Jev too; its options describe generator behaviour, not an outage). The engine keeps
  `consecutiveStageFailures`; any committed step without a stage failure resets it (a step that
  fails at risk after completing intent and context still counts); when it reaches 3 the engine stops with `stopReason = 'error'`, writes `error: { stage, code }`
  into `state.json`, checkpoints, and exits with the error's `exitCode`; `--resume <run-id>`
  continues from the next step.
- A second `GeneratorResponseError` in propose ends the step as in the stage table, IS
  observed by the loop detector (signature `fail:generator:…`) because it is generator
  behaviour, and increments `consecutiveStageFailures`.
- `fatal()` in §11 remains a last resort for bugs; no expected error path relies on it.

**`stop(reason)`** (`loop/stop.ts`) is the single exit for every `StopReason`, including the
budget checks, `complete`, `replan_stop`, `impossible`, `max_replans`, `human_abort`,
`signal`, `error` and the generator-only `generator_done`. It awaits any in-flight
checkpoint write, writes a final checkpoint with `state.stopReason = reason` (same atomic
write to `state.json`, previous copy to `state.prev.json`), appends a `stop` line to
`transcript.log`, emits `run:end`, and resolves `Engine.run()` with the `RunResult`.
`stopReason` is therefore non-null in `state.json` exactly when the run is not in progress.
`Engine.run()`'s `RunResult` is the only thing the bench and the CLI read; they never parse
the run directory for these fields.

**`createdThisRun`**: the engine records new paths by checking existence before every
`write`/`patch` and adding them after a successful execute; it survives `--resume` via
`state.json` and feeds `proposal.target.recoverable` (§5.5).

## 7. Generator (`provider/*`)

`Provider.generate()` streams. `anthropic.ts` speaks the Messages API over SSE
(`message_start`, `content_block_delta` text deltas, `message_delta` usage) `[R]`;
`openrouter.ts` speaks chat completions with `stream: true` and `usage: { include: true }`
so the last chunk carries `usage.cost` `[R]`. `sse.ts` is a small shared parser over
`res.body` (WebStreams). Both map errors to `ProviderError { status, code, retryable }`
and retry with the Anthropic SDK constants (3 attempts, `min(500·2^n, 8000)` ms with subtract-only 25 %
jitter, retry on 408/409/429/5xx/529 and network/idle failures, `Retry-After` ≤ 60 s), while the Jev client uses
the TypeSafe SDK constants of §5.1 (cap 5 s, 5xx except 501). Mid-stream retries re-stream deltas; the renderer
resets its live region on the next `generator:start`. Providers never fall back to `GeneratorConfig.temperature`:
the engine resolves config into `GenerateRequest.temperature` and `null` means the parameter is not sent. Responses are validated (`choices[0]`, `usage`
numbers) before use. `generate()` has no total timeout (streams may legitimately run for
minutes) but aborts and retries as a network error when no byte arrives within 30 s of the
request or no bytes at all (deltas, `ping` events or keep-alive comments) arrive for 60 s; it always awaits `opts.signal` and stops the stream
on abort. `GenerateRequest.temperature` (`number | null`, null = not sent, §3) and
`maxTokens` (`--max-tokens`, default `4096`) are always set by the engine from config and
recorded per call in `generator.jsonl`.

**Structured action channel `[R]`.** The proposal is requested through native tool calling
on both APIs (research `07` §4, RESEARCH.md §0.2): one tool `propose_action` whose
`inputSchema` is the JSON Schema of `{ goal, action, plan }` (the `Action` union as
`oneOf` with `additionalProperties: false` and every key `required`), sent as Anthropic
`tools[]` with `strict: true` and `tool_choice: { type: 'tool', name: 'propose_action' }`
(`GenerateRequest.toolChoice = { name }`), and as the OpenAI-format `tools[]` /
`tool_choice: { type: 'function', function: { name } }` on OpenRouter. The model's text
blocks (its short reasoning) stream to the TUI as `generator:delta`; tool-call argument
fragments stream through `onToolDelta` and the live region shows `streaming action… N
chars`. `actions.ts` takes the proposal from `toolCalls[0].input` when present; if the
reply carries no tool call it falls back to the last fenced ```json block in `text`
(the system prompt still describes that form, so a provider or model that ignores
`tool_choice` degrades gracefully instead of failing the step). Either path is validated by
the same `Action` validator; a missing or invalid proposal is a `GeneratorResponseError`.
`Proposal.rawText` is the text plus the raw tool JSON. Anthropic `input_json_delta` events
and OpenAI `delta.tool_calls[].function.arguments` chunks are accumulated as strings and
parsed once at `message_stop` / `[DONE]`.

**Prompt** (`provider/prompts.ts`): a fixed system prompt (role, one-action rule, the JSON
schema, edit-format rules: `old` must be copied verbatim and match exactly once; prefer
`edit` for changes under ~60 lines, `write` for new files, `patch` only when given a diff;
`run` commands are non-interactive and must finish inside the timeout; one sentence on the
sandbox limits of §8) and one user message per step: task, plan (accepted `done`,
`remaining`, `unverified`, the generator's `openProblems` and the harness-owned
`harnessProblems`, labelled), Jev's effective intent with its Choice probability and paired
Noul value (for a fallback: "Jev found no fitting intent"; under `finish`: "Jev judges
nothing remains; propose `done` if you agree"), `plan_still_valid` and `matches_intent`
hints when they fired, blocked/declined/failed reasons and rejected/unverified claim notes
from the window, the replan directive if any, `workspace.changedFiles` (from the harness's
git `status --porcelain` when the workspace is a repo, so the generator sees on-disk state
regardless of what the window records; on the first step after a resume it is prefixed
"resumed run: these files differ from the last commit"), context files, recent window, and
the instruction to reply with one fenced ```json block:

```json
{ "goal": "one sentence", "action": { "kind": "edit", "path": "…", "old": "…", "new": "…" },
  "plan": { "done": [...], "remaining": [...], "openProblems": [...] } }
```

The system prompt is cache-marked on Anthropic (`cache_control: ephemeral`) `[R]`.
`actions.ts` extracts the last fenced JSON block, parses, validates against the `Action`
union with exact key checks, and raises `GeneratorResponseError` with a precise reason
that is fed back once ("malformed generator response" test); the second failure ends the
step as the §6 stage table says.

Edit format choice `[R]`: exact search/replace with uniqueness (the Claude Code / Anthropic
text-editor convention) is the primary format because it is the most reliable for Claude
models and gives a crisp `EditError` (`no match` / `N matches`) for the loop detector;
unified diff is supported for completeness and is what the bench's mocked provider uses to
replay gold patches. The "patch fails to apply" path is exercised by the explicit §14 test,
not by gold-patch replay (a clean gold patch on `base_commit` applies).

## 8. Sandbox and workspace

`sandbox/run.ts`: `spawn('/bin/sh', ['-c', command], { cwd: workspace, detached: true,
stdio: ['ignore', 'pipe', 'pipe'], env: scrubbed })`, where `workspace` is the canonical
(realpath) path from config, the same value `paths.ts` uses. `detached` makes the shell a
process-group/session leader, which lets `process.kill(-pid, sig)` reach everything that
stays in that group; it does not reach descendants that call `setsid`/`setpgid` (Python
`start_new_session=True`, `setsid(1)`, daemonising servers). `sandbox/kill.ts` therefore
kills in three passes: (1) before sending any signal, snapshot the tree with one `ps -axo
pid,ppid,pgid` from the harness (never inside seatbelt): walk the ppid graph down from
`child.pid` and also include every pid whose `pgid == child.pid` (on macOS the `sess`
column is always 0 and must not be relied on); (2) `process.kill(-child.pid, 'SIGTERM')`
plus `process.kill(pid, 'SIGTERM')` for each snapshotted pid, ignoring `ESRCH`; (3) after
2 s, re-run the snapshot (to pick up anything forked in the meantime while its parent was
still alive), union with the first snapshot, and repeat (2) with `SIGKILL`; then a final
`ps` check of the union. Any pid from the union still alive is recorded in
`ExecResult.orphans`, shown in the transcript pane, and included in the judge state
(`executed.orphans`) so Jev can weigh it, never silently dropped. Processes that
double-forked and re-parented to launchd before the first snapshot are outside what the
harness can identify and are documented as a known limit in the README alongside the
seatbelt limits. Because `ps` is only invoked on kill paths (timeout, wall time, abort), it
does not affect the < 50 ms per-step overhead budget. Env is rebuilt from an allowlist
(`PATH`, `LANG`, `TERM`, `TMPDIR` → run tmp, `HOME` → `<run>/home`) so no API key reaches a
subprocess.

stdout and stderr are read as streams with one shared byte counter. Up to `maxOutputBytes`
(default 200 KB) is retained as `head`; past that the harness keeps draining both pipes
into a rolling `tail` buffer (last 16 KB) and discards the rest. Reaching the cap never
kills the process and is not an error: only the timeout, wall time or abort kill the tree.
The cap bounds harness memory; the timeout bounds runtime. `killedBy` is set by the code
path that issues the kill, before signalling, so the `close` handler only records
`exitCode`/`signal` and never overwrites it; `timedOut` is derived as `killedBy ===
'timeout'`. Default timeout 120 s, per-action override capped at 600 s, both further clamped
to the remaining wall-time budget (§6); `run()` accepts `{ timeoutMs, maxOutputBytes,
signal, onOutput }` and records `killedBy` on every harness-initiated kill.
`Sandbox.run()` resolves, never rejects, on timeout, wall time and output cap: the result
carries `killedBy` / `truncated` and `ok = exitCode === 0 && killedBy === null`, so the
judge sees the output and the loop detector sees a `fail:` signature on a non-zero exit.
It rejects only with `AbortError` (engine abort with a non-budget reason) or
`SandboxError` (spawn failure: `/bin/sh` missing, EACCES, cwd gone).

`sandbox/seatbelt.ts` `[R]`: on darwin, when `sandbox-exec` exists and `--sandbox` is
`auto`/`seatbelt`, the command runs under a generated profile. `(deny default)` breaks
toolchains, so the base is `(allow default)` with writes and secret reads denied. Every
path is `realpath`ed in the harness before insertion (`subpath` needs kernel-canonical
paths: `/tmp` → `/private/tmp`, `$TMPDIR` → `/private/var/folders/...`, which is where
`os.tmpdir()` and the bench's temp workspaces live; a symlinked prefix in the profile
silently denies everything under it); the real home comes from `os.homedir()`, not
`$HOME`, because the child's `HOME` is remapped to `<run>/home`.

```
(version 1)
(allow default)
(deny file-write*)
(allow file-write* (subpath "<ws>") (subpath "<run tmp>") (subpath "<run home>")
  (literal "/dev/null") (literal "/dev/stdout") (literal "/dev/stderr")
  (literal "/dev/ptmx") (regex #"^/dev/ttys[0-9]+$") (subpath "/dev/fd"))
(deny file-write* (literal "<ws>/.git/config") (subpath "<ws>/.git/hooks")
  (literal "<harness tty>"))                       ; realpath('/dev/fd/1') when stdout.isTTY
(deny file-read* (literal "<each dotenv path consulted by resolveConfig>")
  (literal "<config file path>") (subpath "<home>/.jevcode") (subpath "<home>/.config/jevcode")
  (subpath "<home>/.ssh") (subpath "<home>/.aws") (subpath "<home>/.config/gh")
  (literal "<home>/.netrc"))
(deny network*)                                    ; only when --no-network
```

Later rules win in SBPL, so the read denials override `(allow default)` and the specific
`.git` denials override the workspace allow (verified; equivalently wrap the allow in
`(require-all (subpath "<ws>") (require-not (literal "<ws>/.git/config")) (require-not
(subpath "<ws>/.git/hooks")))`). Verified on the reference machine: with the denials, `cat
<pkg>/.env` and `ls ~/.ssh` fail with EPERM (also through a symlink created inside the
workspace), while `python3`, `git commit`, `node`, and in-workspace writes succeed. Not
denied on purpose: reads elsewhere (other repos, `~/Documents`) and outbound network unless
`--no-network`; this is the same posture as Gemini CLI `permissive-open`, Claude Code and
Codex `workspace-write`, and the README says so. `~/Library/Keychains` is not listed because
keychain access goes through `securityd` over Mach, so a file-read deny there is
ineffective. Known consequences, documented in the README: `ssh` resolves `~/.ssh` via
getpwuid, so `git clone git@...` and `pip install git+ssh://` fail inside the sandbox (use
https); some Apple platform binaries (`/bin/ps` verified) fail at exec with `sandbox-exec:
execvp() ... Operation not permitted`, exit 71, under any profile: `ExecResult.sandboxExecDenied`
is set when stderr shows that message with exit 71 so Jev attributes the failure to the
sandbox rather than to the task. The profile may be passed with `-p <string>` or `-D
WS=<realpath> -f <file>`; if a file is used it lives at `<run>/sandbox.sb`, outside the
child's writable roots. The fallback level (no `sandbox-exec`) has none of these read or
write denials: the guarantee degrades to cwd + env scrubbing + timeout + output cap + tree
kill, and `jevcode config` prints which level is active and that at the `none` level
`.git/config` and `.git/hooks` are writable by commands and defence 2 below is the only one
active. `.git/index`, `.git/refs`, `.git/objects` stay writable so `git add/commit/checkout/
stash` keep working; `.git/*.lock` is not denied (git needs `index.lock`/`config.lock`).

**`.git` is attack surface for the harness's own git.** A `run` action may write anything
under the workspace, including `.git/config` and `.git/hooks/*`; git executes
`core.fsmonitor`, `core.hooksPath` hooks, `diff.external`, `diff.<driver>.textconv`,
`filter.<driver>.clean`, `core.pager` and `core.sshCommand` from repo config on ordinary
commands such as `git status`, `git diff`, `git ls-files` and `git checkout` (verified on
git 2.50.1: after a sandboxed child set `core.fsmonitor`, an unsandboxed harness `git status
--porcelain` ran the planted command). Two defences, both required:

1. Profile: the `.git/config` and `.git/hooks` write denials above. This defence is a speed
   bump only: it is bypassed by `mv .git .g; echo 'gitdir: .g' > .git` (verified), and it
   does not exist at the `none` level.
2. Harness git never runs with `process.env` (`workspace/git.ts`, the single entry point):
   every git command the harness itself issues in or about the workspace (`git rev-parse
   --is-inside-work-tree`, `git ls-files` in `workspace/candidates.ts`, the `changedFiles`
   computation, `proposal.target.tracked`, and the bench evaluators' `git checkout <base>
   <test files>` / `git apply` in `bench/swebench/evaluator.ts`) goes through
   `sandbox/run.ts` with the same scrubbed env allowlist, the same seatbelt profile when
   active, the same timeout and output cap, and additionally `GIT_CONFIG_NOSYSTEM=1`,
   `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_TERMINAL_PROMPT=0`, and the flags `-c
   core.fsmonitor=false -c core.hooksPath=/dev/null -c core.pager=cat -c core.sshCommand= -c
   credential.helper=` plus `--no-optional-locks` on `status`, `--no-ext-diff --no-textconv`
   on `diff`. A planted command then executes, if at all, only inside the sandbox with no
   keys (verified: under the profile with a scrubbed env the hook ran and could not write
   outside the workspace), which is exactly the privilege a generator `run` already has.
   Harness git output is treated as untrusted text (bounded, redacted) like any command
   output.

`sandbox/paths.ts`: `resolveInside(ws, p, mode: 'read' | 'write')`: `path.resolve(ws, p)`,
then find the longest existing prefix of the result *including the full path itself*,
`realpath` that prefix (so a symlink at the final component is followed), append the
non-existent remainder, and require the outcome to equal `realpath(ws)` or start with
`realpath(ws) + sep`; for `mode: 'write'` the outcome must also not be inside
`realpath(ws)/.git`. Any failure throws `PathEscapeError(kind: 'outside' | 'symlink' | 'git'
| 'absolute')` before anything touches disk. Symlinks whose target resolves inside the
workspace are allowed. The dotenv paths and config file path consulted by
`resolveConfig()`, plus any `.env`/`.env.*` (except `.env.example`), `*.pem`, `*.key` and
`id_*` inside the workspace, are rejected by `read`/`edit`/`write`/`patch` with
`SecretPathError` (a `PathEscapeError` subclass) and are dropped from the candidate list, so
the harness never hands its own secret store to the generator or to Jev even when the
workspace is the JevCode checkout. All harness file access goes through `resolveInside`,
not only generator actions: `workspace/files.ts` (context-stage reads), `edit.ts`,
`patch.ts` (every hunk path, both old and new), `tests.ts` (manifest detection), and
`candidates.ts`. (These run in the harness process, outside the sandbox.)

`workspace/edit.ts`: exact match must occur exactly once (`EditError` otherwise); writes
are atomic (`atomic.ts`: write `path.tmp-<pid>-<rand>` then `rename`; `atomic.ts` takes
`{ fsync: boolean }` and the checkpoint store is the only caller that passes `true`).
`workspace/patch.ts` `[R]`: unified diffs are applied with `git apply` through
`workspace/git.ts` (scrubbed env, sandbox profile when active): every path on the `---`/
`+++` lines is first checked with `resolveInside(ws, p, 'write')`, then `git apply --check
-p1` runs against the workspace (never `--unsafe-paths`, never `--3way`, never `--reject`);
only if it passes does `git apply -p1` run, so the patch is all-or-nothing. `git apply`
works outside a git repository, rejects `../`, `-p0` absolute paths and symlink-traversing
paths, and gives a hunk-level error message (research `09` §2.2, verified on git 2.50.1);
that message is the `PatchError.hunk`. A hand-written applier would be more code for less
safety (DECISIONS.md). `workspace/tests.ts`: detects a test command (pytest,
`npm test`, cargo, go test) from manifests and parses pytest/jest/cargo summaries into
counts for the judge state (from the tail when truncated).

`workspace/candidates.ts`: the listing is computed once at run start (and again on
`--resume`) and cached as `Map<path, { bytes, binary, touchedThisRun }>`.
`edit`/`write`/`patch` outcomes update the cache from `changedFiles` (stat each; remove
entries whose file no longer exists). Only a `run` outcome invalidates it, because commands
can create or delete files; the re-list starts immediately after execute so it overlaps the
judge request, and only paths not already in the cache are stat'ed and sniffed. Git listing
is `git ls-files -s -co --exclude-standard` (tracked plus untracked-not-ignored, so files the
generator created remain candidates) through `workspace/git.ts`; entries with mode `120000`
(symlinks) and any entry whose `resolveInside(ws, path, 'read')` fails are dropped. The
non-git walk uses `readdir({ withFileTypes: true })`, uses `lstat` and skips symlinks
likewise, skips `.git`, `node_modules`, `.venv`, `venv`, `dist`, `build`, `__pycache__`,
`target`, `.tox`, `.mypy_cache`, `.pytest_cache`, and stops at 20,000 entries with a
transcript warning naming the cap. Binaries and files > 1 MB are dropped, using the cached
stat.

`Workspace.changedFiles()` is computed relative to a snapshot taken by `createWorkspace()`:
git: `git -c ... status --porcelain --untracked-files=all` through `workspace/git.ts`, minus
the snapshot's dirty set, plus files the run wrote; non-git: a before/after mtime+size
snapshot of the file actions' paths. It never attributes pre-existing dirty files to the
run.

### 8.4 Secrets and redaction (`core/redact.ts`)

`core/redact.ts` exports `redact(s: string): string` and `redactJson(v: Json): Json` (string
leaves only) built from a `SecretSet` that `resolveConfig()` assembles once and passes to
the engine, client, provider, checkpoint writer and renderers. The `SecretSet` contains (a)
every resolved value of a secret setting (generator key, decider key) regardless of source
(flag, env, dotenv, file), and (b) every value in every loaded `.env` file whose variable
name matches `/(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i`, even when JevCode does not use
that variable. Values shorter than 8 characters are ignored. `redact()` first replaces these
exact strings (longest first) with `[REDACTED:<setting-or-var-name>]`, then applies format
patterns, each replaced with `[REDACTED:pattern]`: `sk-or-v1-[A-Za-z0-9]{20,}`,
`sk-ant-[A-Za-z0-9_-]{20,}`, `sk-(proj-|live_|test_)?[A-Za-z0-9_-]{20,}`,
`AIza[0-9A-Za-z_-]{35}`, `gh[pousr]_[A-Za-z0-9]{36,}`, `github_pat_[A-Za-z0-9_]{22,}`, and
`/(authorization:\s*bearer|x-api-key:)\s*\S+/gi` (value only). No generic long-token rule:
40-hex git SHA-1s, npm integrity hashes and base64 blobs are legitimate command output for a
coding agent and must stay intact. Until `resolveConfig()` has run, `redact()` applies only
the patterns.

`redact()` is applied at every sink, and the sinks are enumerated: `ExecResult.stdout/stderr`
before they enter `ActionOutcome`; every string placed into Jev `state` (`executed.output`,
context file contents, plan text); every generator message (plan, window, context files);
every `Error.message` and `cause` chain in `fatal()` and in `JevHttpError`/`ProviderHttpError`
bodies; every line written to `steps.jsonl`, `decisions.jsonl`, `jev.jsonl`,
`generator.jsonl`, `transcript.log`, `run.json`, `state.json`, `state.prev.json`, bench
`tasks.jsonl`, `summary.json` and the markdown report; and every event string handed to the
TUI reducer or `tui/plain.ts`. `run.json` and `jevcode config` record secret settings only
as `{ source, fingerprint }` (§3); flag-sourced keys are fingerprinted identically and the
raw argv is never logged.

## 9. Checkpoints and resume (`checkpoint/*`)

`~/.jevcode/runs/<run-id>/`:

**Run id** (`checkpoint/run-id.ts`): `<YYYYMMDD>-<HHMMSS>-<8 lowercase base32 chars>` where
the suffix is `crypto.randomBytes(5)` encoded with the RFC 4648 alphabet `a-z2-7` (40
random bits), e.g. `20260919-142301-k7q2m6xa`. UTC time; sortable; filesystem-safe on
case-insensitive volumes. `runsDir` is created with `mkdir -p` once; the run directory itself
is created with a non-recursive `mkdir` and `EEXIST` regenerates the random suffix, so
concurrent bench workers (`--concurrency N`) can never share a directory. The same id is the
`runId` in `tasks.jsonl` (§13).

**Resume validation**: `--resume <run-id>` must match `^\d{8}-\d{6}-[a-z2-7]{8}$` (the alphabet excludes 0, 1, 8 and 9) and
`realpath(join(runsDir, runId))` must start with `realpath(runsDir) + sep` (the same
containment rule as `sandbox/paths.ts`); anything else is `ConfigError` naming the flag
(exit 2). This check runs before the run dir is used for `<run>/home`, `<run>/tmp` or the
seatbelt profile (§8), so a run id can never widen the sandbox's writable set. A well-formed
id whose directory does not exist is `CheckpointError` (exit 3).

| File | Content | Written |
| --- | --- | --- |
| `run.json` | `RunMeta` (§4): task, workspace (realpath), mode, the full `ResolvedConfig` with each secret value replaced by `{ source, fingerprint }` (§3) and every `source` kept, versions, createdAt, `overrides: []`, `resumes: []`, `resolvedJevModel`, `jevModelDrift` | once at init; `overrides`/`resumes`/model fields appended atomically on resume or first Jev call |
| `state.json` | `CheckpointEnvelope` = `{ version, checksum, state: CheckpointState }` (§4) | atomically after every committed step and on every stop; previous copy kept as `state.prev.json`; when a load had to fall back to `state.prev.json`, the unusable `state.json` is parked as `state.corrupt.json` by the next write instead of being rotated over `prev` |
| `steps.jsonl` | one `StepRecord` per committed step | appended every step |
| `decisions.jsonl` | one `Decision` per Jev question; `latencyMs` is the parent request's latency and is for display only, not a metric source | appended per Jev call |
| `jev.jsonl` | one `JevRequestRecord` per Jev request (mirror of `generator.jsonl`) | appended per Jev call |
| `generator.jsonl` | one `GeneratorCallRecord` per generator call (prompt hash, model, temperature, maxTokens, usage, latency, malformed) | appended per call |
| `transcript.log` | the plain-text transcript, one line per transcript item (§10) | appended |
| `model_patch.diff`, `eval/` | bench only (§13) | after the run |

Everything passes through `redact()` before serialisation (§8.4).

**Write order and overlap.** Per step: `appendDecisions`, `appendJevRequest` and
`appendGenerator` as each call returns, then `appendStep`, then `writeState`. `state.json`
is the only artefact read on resume and is authoritative. Durability rule: `state.json` is
written through `atomic.ts` with `fsync` on the temp file before `rename`; `state.prev.json`
is produced by renaming the previous `state.json` immediately before the new rename, never
by copying; `steps.jsonl`, `decisions.jsonl`, `jev.jsonl`, `generator.jsonl` and
`transcript.log` are plain appends with no fsync (~0.1 ms each). The checkpoint for step N
may overlap step N+1's intent/context/propose/risk stages but is awaited before step N+1's
`execute` stage and on shutdown (§6). The JSONL logs may therefore end with rows for a step
that was never checkpointed; readers (bench, report) take the last row per `step` and skip
a corrupt trailing line with a warning.

**Resume.** `--resume` loads `state.json` (or `state.prev.json` on checksum/version failure
or ENOENT, with a transcript warning) as the sole truth, then reads `steps.jsonl` and, for
every record with `step > state.step`, folds that record's own content (action summary,
outcome status, changed files, `interruptedAt` if present) into the window, advances
`lastChangeStep` when the folded record changed files (so `testsCurrent` stays honest), and sets
`state.step` to the highest such step; plan and spend are not reconstructed from it (spend
is re-derived from the checkpointed meter snapshot; the plan update of a lost step reappears
through the generator's next `PlanDraft`). If both files fail it throws `CheckpointError`
naming the run dir (exit 3). Resume always begins a new step at `intent`; no stage is ever
re-run and no recorded proposal is replayed. The workspace is the real directory, so file
state persists across resume; `step`, `plan`, `window`, `spend`, `wallMsUsed`,
`loopDetector` (including `tripsBySignature` and `replanCount`), `lastTestRun`,
`lastChangeStep`, `createdThisRun`, `resolvedJevModel` and a pending `directive` continue.
`SpendMeter.restore()` is called before the first stage. `--max-wall` is compared against
`wallMsUsed` plus time since this process started, so time spent paused between resumes is
not counted. A resumed run whose last committed step has `interruptedAt` starts a new step at
intent; a run whose last step was discarded (§9.1 rule 1) re-runs the same step number, and
the engine writes `resumed at step N` to the transcript. The engine clears `stopReason`,
increments `state.resumes`, and appends `{ resumedAt, previousStopReason }` to `run.json`.

**Configuration on `--resume`.** Task, workspace, mode, provider, generator and decider
models and base URLs, completion and impossible thresholds, and sandbox profile are taken
from `run.json` and replace the normal precedence chain (a run must stay comparable with
itself). An explicit `--workspace` is accepted only if its realpath equals
`run.json.workspace`; an explicit `--provider`, `--model` or `--jev-model` that differs is
`ConfigError` (exit 2). Task text together with `--resume` is a usage error (exit 2). Limits
(`--spend-cap`, `--max-steps`, `--max-wall`, `--max-replans`) and secrets (`--api-key`,
`--jev-api-key` and their env vars), `runsDir`, `--config` and `--extra-env-file` are
re-resolved from the current invocation under §3 precedence, never read back from
`run.json`; a limit that differs from the stored value is appended to `run.json.overrides[]`
as `{ setting, from, to, atStep }` (secrets never recorded). Stored `stopReason` handling:
`complete` → refuse with `ConfigError` (exit 2) unless `--force`; `spend_cap`, `max_steps`,
`wall_time` or `max_replans` whose corresponding limit has not been raised above the stored
`spend` / `step` / `wallMsUsed` / `replanCount` → the run exits before rendering the loop
with that reason and a one-line message naming the stored value and the flag to raise (exit
4, nothing appended to `steps.jsonl`); any other value or `null` (crash before the final
checkpoint) → resume normally. `decisions.jsonl` and `jev.jsonl` record the decider model id
per call so overrides and drift are visible in the record.

### 9.1 Step commit rule

A step is committed iff a `StepRecord` for it is appended to `steps.jsonl`. `state.json` is
always rewritten on any stop (signal, human abort, budget, fatal error) with the current
spend, `wallMsUsed`, `stopReason`, and the step counter, so no spend is ever lost across a
resume; `--resume` then re-checks budgets against the possibly raised flags before starting.

1. Abort or budget stop before `execute` starts (during intent, context, propose, risk,
   while a confirmation is pending, or at the before-execute `checkBudgets`): the step is
   discarded. No `StepRecord` is appended, `step` does not advance, nothing enters `recent`,
   the loop detector does not observe it, and it does not count toward `max_steps`.
   `state.interrupted = { step, stage, proposal }` keeps the proposal (if one exists) so the
   transcript and the resumed transcript can show what would have run. Rows already appended
   to `decisions.jsonl`, `jev.jsonl` and `generator.jsonl` for that step number stay (they
   are append-only and their cost is in `state.json`); `steps.jsonl` is the source of truth
   for which steps exist. Resume re-runs the step from intent.
2. Abort during `execute` (`signal`, `human_abort`, `wall_time`, or a fatal error; `spend_cap`
   and `max_steps` are never checked inside execute): the sandbox tree is killed (§8), the
   step is committed with `outcome: { status: 'interrupted', exec }` (partial `ExecResult`
   for `run`, with `exec.killedBy` `'abort'` or `'wall_time'` and `exec.signal` set; absent
   for file actions that had not written), `changedFiles` taken from the harness git `status
   --porcelain` (empty when not a repo or the kill is a forced second Ctrl-C), `judge: null`,
   `completion: null`, `interruptedAt: { stage: 'execute', reason }`. The plan draft is not
   applied. The window shows it as `outcome: 'interrupted'`, never as a failure. The loop
   detector does not observe it (no `run:`, `patch:` or `fail:` signature). It counts toward
   `max_steps`.
3. Abort after `execute` completed but before judge+complete returned: the step is committed
   with the real `outcome` (`executed`/`noop`/`failed`/…), `judge: null`, `completion: null`,
   `interruptedAt: { stage: 'judge', reason }`. The plan draft is not applied (no judge
   evidence; done claims rejected). The window shows the outcome plus the note `interrupted
   before judge`, so the generator sees the change that exists on disk. The loop detector
   observes it using the action signature and, when `exec.exitCode !== 0 && !exec.signal`,
   the `fail:` signature; it counts toward `max_steps`.

The same rule applies to the budget checks (§6: `spend_cap` fires only at rule-1 points; a
judge call that crosses the cap completes the step whole and the run stops at the next
step start), to `shutdown()` (§11), and to `fatal()`. "Await checkpoint" in §11 means: write
`state.json` per this rule and await the previous step's overlapped write. A child killed by
the harness on abort has `exitCode: null, signal: 'SIGTERM'|'SIGKILL', killedBy: 'abort'`; a
child killed on timeout has `killedBy: 'timeout'`; only the second is a failure.

### 9.2 Interactive-session additions (2026-09-20; TUI-DESIGN §8, §12.3–§12.5, D7, D8)

All additive; a run directory written by an earlier version loads unchanged.

| Path | Content | Written |
| --- | --- | --- |
| `run.lock` | `{ "pid", "startedAt", "host" }` (`src/session/lock.ts`) | by `createEngine` after `store.create` / the resume load; removed in `finish()` and by the `'exit'` handler. On `--resume` a lock whose pid is alive on the same host is `ConfigError` (exit 2) naming `jevcode sessions unlock <id>`; a dead pid or another host is replaced with a `jevcode.log` warning; the picker marks such rows `● live` |
| `pre/<step>/<sha256(relpath)>`, `pre/<step>/dirs.json`, `pre/<step>/index.json` | the bytes of every `edit \| write \| patch` target (the dirty set before a `run`) before the step; files > 1 MiB are recorded, never copied; the directories the step will create (`src/checkpoint/images.ts`) | in `runStep()` right before the execute stage |
| `post/<step>.json` | `{ v, step, at, headOid, files: { <rel>: { sha256, bytes, mode, source, preImage, cleanAtStart \| created \| deleted } }, skipped, hashSkipped }`; hashing streams 4 MiB chunks with a `setImmediate` yield and stops at a 16 MiB per-step budget (`sha256: null` beyond it); the time is `StepTiming.imagesMs`, inside `harnessMs` | after execute, inside `runStep()` so the harness gate sees it; renamed `post/<step>.undone.json` by `/undo` |
| `ui.json` | the composer draft with every `detectSecrets` span replaced by `[REDACTED:draft]`, cursor, chip labels (`fp8` fingerprints, never bodies), tab, theme | at checkpoint boundaries and on exit, never per keystroke |
| `jevcode.log` | the per-run log (§11 below; `src/core/log.ts`) | throughout |
| `~/.jevcode/sessions/index.jsonl` | append-only, `v:1`, ≤ 512-byte lines: `run:start`, `run:end`, `rename`, `steer`, `undo`, `pause`, `budget` (`src/session/index.ts`); `task60`/`title60`/`text60` are `clip(oneLine(redact(x)), 60)`; folded once per session open, `/resume`, `run:end` and `budget:override`; no lock file — `jevcode sessions reindex` rebuilds it from every `run.json` | only for `source === 'cli'` (bench and perf never write it) |

**Sessions and follow-ups.** A session is the ordered runs of one workspace realpath; `sessionId` is the first
run's id and a follow-up's `parentRunId` is the run it was seeded from. A follow-up is a **new run** whose seed
(`src/session/seed.ts`, pure) carries the parent's plan (`done`, `remaining`, `unverified`), the last 4 window
entries (each annotated `from run <id>`), `createdThisRun`, `lastTestRun`, `undoLog` and the `@`-mentioned
`pinnedFiles`; the parent's framing, the human's `/undo`/`/rewind` notes and the parent's still-pending steers become
step-0 `human` harness problems, which a later mid-run steer never supersedes (only steer problems, `step > 0`,
are). The engine logs `seeded from run <id>: plan done=a remaining=b unverified=c · window N entries · M created
files`. The seed source is the most recent run of the session with `state.step > 0`, else the most recent run.
Legacy `run.json` reads as `{ sessionId: runId, parentRunId: null, source: 'cli' | 'bench', instructions: [] }`.

**New stop reasons.** `human_pause` (Esc or `/pause`: `finish('human_pause')` at the loop top after the in-flight
step committed whole — §9.1 rule 1 — exit-4 family, **not** a budget stop, so `--resume`/`/resume` proceeds without
`--force`; the epilogue reads `paused after step N — /resume continues, or type a follow-up`) and `token_cap`
(`--allow-unpriced` runs under `limits.maxGeneratorTokens`; a budget stop like `spend_cap`, blocked on resume until
`/budget max-generator-tokens <n>` raises the limit; the counter is rebuilt from `generatorTokensPerStep` on resume).
`BUDGET_STOP_REASONS` in `src/loop/stop.ts` is the one list.

**`/undo` and the finished run.** `/undo [n]` (`src/undo/plan.ts` pure decision table, `apply.ts` I/O) verifies every
file against `post/<n>.json` before its first write — restore when the sha256 matches or the file was deleted,
**refuse** when a later step changed the same file again (`use /rewind`), **ask** (default `n`) when it changed
outside JevCode, skip symlinks, hard links, escapes, submodules and, for a clean tracked file a command changed,
skip with `not recoverable — HEAD moved since step N` when `HEAD` differs from the recorded `headOid`. Restore
sources in order: pre-image → unlink of created files → `git restore --source=HEAD --worktree -- <path>` through
`runGit` with the neutralising flags (never `checkout --`, `--staged`, `stash`, `reset`, `clean`). The finished run's
`state.json` is **never rewritten**: the `undoLog` entry and the note `human reverted step N: …` travel in the next
run's seed (or in `EngineOptions.undoLog` / `humanDirective` when that same run is resumed), and the index gets an
`undo` line. `/rewind [step]` undoes `last…n` in reverse and may seed the next run from `StepRecord.planAfter` of
step n.

## 10. TUI (`tui/*`)

One Ink `render()` of `<App>`, chosen only when `interactive = stdin.isTTY && stdout.isTTY && !CI &&
TERM !== 'dumb' && !--plain && !--json && !--no-input` (`cli/main.tsx` `selectRenderer`, TUI-DESIGN §1);
otherwise `tui/plain.ts` is used — with a `node:readline` line composer (`tui/plain-composer.ts`) when stdin and
stdout are TTYs under `--plain`, and no composer on a pipe, under `CI`, `TERM=dumb` or `--no-input` (every prompt
takes its safe default); `--json` selects the NDJSON writer (`cli/json-stream.ts`). The 2026-09-19 monitor described
in this paragraph is the run-mode skeleton; the interactive session is described at the end of the section. Panes:
a transcript pane (`<Static>` for committed items so Ink never re-renders old rows; the live
generator region under it), a decisions pane (last 12 `Decision`s: stage, id, answer,
probability, confidence; `review` rows yellow, `block` rows red, `overridden` and
`fallback` rows yellow, `ok`/`chosen` dim; Noul confidence labelled "derived"), a status
line (step/max, wall time, tokens generator/Jev, cost generator/Jev over cap, current stage,
spinner; rendered from the `status` event payload, never by reading the meter), and an
inline confirmation box (`[y] approve  [n] decline`) rendered while a `confirm:request` is
pending. UI state comes from a reducer fed by `EngineEvent`s (§4).

**Transcript items** are immutable, one per event, appended in event order, keyed
`${step}:${kind}:${seq}` where `seq` is a monotonic counter. Item kinds: `run:start`,
`run:ready`, `intent`, `context`, `proposal` (final text), `risk` (verdict + reason,
coloured like the decisions pane), `confirm:resolved`, `outcome`, `judge`, `plan`
(rejected/unverified claims), `loop:tripped`, `replan`, `transcript`, `error`, `run:end`.
Nothing about a step is edited after commit; later information about the same step is a
later item. Items are never removed or reordered (`<Static>` renders by position, so the
array is append-only). `decision`, `jev:request`, `status`, `stage:*`, `checkpoint` and
`exec:output` events do not create transcript items; they feed the decisions pane, the
status line and the live region. Streaming: `generator:delta` accumulates in a ref and a ≤
20 fps timer copies it into the live region's state; `exec:output` chunks and
`generator:tool-delta` counts go through the same buffer (display only, no items), so a chatty
command cannot force one React dispatch per chunk; every other event is one dispatch. The reducer handles `proposal` as a single action that appends the `proposal`
item and clears the live buffer in the same state update, so no frame shows the proposal
text twice or not at all. Every other event is one reducer dispatch. `tui/plain.ts` and
`transcript.log` render the same item list, one line per item
(`[step 3] intent=edit p=0.82 c=0.71`), so the three transcripts agree line for line;
`plain.ts` writes generator deltas raw with `stdout.write` and terminates the line at
`proposal`.

**Height budget.** Ink 7.1.1 switches to `clearTerminal + fullStaticOutput + frame` on every
frame whose dynamic output is taller than the viewport (`shouldClearTerminalForFrame`,
`wasOverflowing || (isOverflowing && hadPreviousFrame)`), which replays the whole
transcript per frame and is the flicker path documented in Qwen Code #1778 and Ink #450
(research `01` §4). The dynamic region therefore never exceeds `rows − 2`, with `rows` from
`useWindowSize()` (Ink falls back to 24 when unknown; the same budget applies). Every
dynamic pane is a fixed-height `<Box overflow="hidden">` so the budget holds even when
content wraps:
- live generator region: `height={2}`; it shows the last two lines of the accumulated
  stream, each truncated to `columns` (`<Text wrap="truncate">`), or `streaming… N chars`
  when the buffer has no newline yet. The full proposal text is committed to `<Static>` as a
  transcript item when the stream ends, so nothing is lost.
- a one-row rule between `<Static>` and the live panes, then the decisions pane:
  `rows_d = min(12, rows − 2 − 1 − liveRows − statusRows − confirmRows)` most recent decisions,
  one row each, `height={rows_d}` (verified in a real pty at rows 12: exactly 10 dynamic rows,
  zero clear-terminal sequences).
- status line: 1 row, truncated to `columns`.
- confirmation box: rendered only while `confirm:request` is pending. Before it renders,
  the proposal (goal, action, plan draft) is committed to `<Static>` as a transcript item so
  the human has the full text in scrollback; the box itself shows goal, action kind and
  target (path or command), the four risk dimensions with level, probability, confidence
  and the reason, the `[y] approve  [n] decline` line, and a preview of
  `old`/`new`/`content`/`command` clipped to whatever remains of the budget, capped at 8 rows
  (`MAX_PREVIEW_ROWS`) so the decisions pane keeps rows on tall terminals
  (`height={min(8, previewRows, rows − 2 − liveRows − statusRows − 6)}`), never fewer than 0
  preview rows and never pushing the region past `rows − 2`. The decisions pane shrinks
  first to make room.
On resize (`useWindowSize()` re-render) the budget is recomputed from the new `rows`.

`render({ exitOnCtrlC: false, patchConsole: false })`. Ink holds stdin in raw mode while
`useInput` is active, so the terminal sends no SIGINT on Ctrl-C; the byte arrives in
`useInput` as `key.ctrl && input === 'c'` (research 01 §3, 09 §4). `<App>` mounts one
`useInput` hook that stays active for the whole run (not only while a confirmation is
pending), with `{ isActive: Boolean(isRawModeSupported) }` so that `<App>` rendered with a
piped stdin never throws "Raw mode is not supported"; it maps Ctrl-C to
`shutdown('human_abort')` (§11) and handles `y`/`n` only while `confirm:request` is pending.
The TUI Confirmer (`tui/useEngine.tsx` `createTuiConfirmer()`) stores the resolver,
dispatches the request to the reducer, resolves on y/n, and rejects with `AbortError` on
`signal`; when stdin is not a TTY the box renders but declines after `confirmTimeoutMs`.
`process.on('SIGINT'|'SIGTERM')` stays registered in both modes for external `kill`. Plain
mode (`tui/plain.ts` `createReadlineConfirmer()`): y/n on TTY stdin with `signal` passed to
`rl.question`, the `readline` interface created with `terminal: false` (or registering
`rl.on('SIGINT', () => shutdown('signal'))`) so Ctrl-C during a plain-mode confirmation is
not swallowed by readline; otherwise immediate `false`. The bench's Confirmer
(`bench/conditions.ts` `alwaysDecline`) returns `false`.

**Interactive session (2026-09-20/21; TUI-DESIGN §1–§7, §15.1, D1, D12).** A bare `jevcode` (or `jevcode chat`,
or `jevcode run` with no task on a TTY) mounts `<App mode="session">` and runs nothing until the first Enter; every
run is driven by `cli/session.ts` `createSessionController`, which `jevcode run "<task>"` shares with
`mode: 'one-shot'`. The dynamic region is allocated by one pure function, `computeLayout(rows, columns, state)`
(`src/tui/layout.ts`): vertical order `<Static>` scrollback · rule · live (≤ 2) · loop banner (≤ 1) · Jev pane (≤ 12)
· steer queue (≤ 2) · one modal overlay slot · review preview (≤ 8) · composer (≤ 6, 8 when tall) · status; allocation
priority status → rule → composer floor → overlay → composer growth → queue → preview → live → banner → pane, and the
yield order is its reverse; below 40×8 the region degrades to status · notice · composer. Exactly one overlay exists
at a time (`review | wizard | followup | secret | blocking | palette | undo | exitConfirm`); a review, follow-up box,
blocking pane or exit confirm collapses the composer to one inactive row, so no typed `y` can ever approve. The
composer is a readline-style multi-line editor (`src/tui/composer/*`: grapheme cursor, `string-width`-identical
cell widths, kill ring, 100-step undo, history in `~/.jevcode/history.jsonl`, paste chips whose bodies never leave a
`useRef`); every key is resolved by `resolveKey` over an enumerated `KeyState` and the Ctrl-C / Esc / Ctrl-D matrix
by the pure `reduceInterrupts` (`src/tui/keys/*`); Enter routes through `routeSubmit` (`composer/submit.ts`): a `/`
line runs a command only on an exact name or alias match and otherwise keeps the draft — a submitted line is a paid
run. The panes are `lines()` functions shared by the Ink, `--plain`, `--screen-reader` and `--ascii` twins
(`src/tui/{review,pane,status,blocking,budget,onboarding}/lines.ts`).

**Transcript identity, kept for the whole run.** `TranscriptItem` gains an optional `label`
(`'[ui]' | '[setup]' | '[config]' | '[sandbox]'`), and `formatTranscriptItem` prints `<label> <text>` in place of
`stepLabel()` when one is set. A line the renderer originates while a run is live (`/plan`, `/why`, `/diff`, `/cost`,
help, undo output, the 12,000-character notice, `/budget` changes) goes through `SessionHost.note()` →
`Engine.annotate(text, { detail, label })` → `notice { kind: 'ui', label }` → `emit()`, so `transcript.log`,
`--plain` and the TUI stay line-identical for the entire run. The only lines outside that identity are the ones
produced while no engine is live — session start, between runs, the session epilogue — for which no
`transcript.log` exists; they appear in the TUI and `--plain` as `[ui]` items and on the `--json` stream as
`ui { text, label }` lines. Ephemeral toasts and idle Ctrl-C/Ctrl-D hints are in none of the three.

**Round 2 (2026-09-21; TUI-DESIGN-2 §1, §3–§5, §9).** Three changes to the paragraphs above, each a declared
amendment. (1) *Every submission is decided by Jev first.* `SessionHost.submit()` returns a `SubmitOutcome`
(`became: 'run' | 'chat' | 'nothing'`); a non-command line is appended as a `[you]` item (label `'[you]'`, one item
per line, redacted at emission), then `src/chat/intake.ts` builds one Jev request — the `intake` Choice over five
readings with paired Nouls, the reply Choice over the 14-row catalogue (`src/chat/replies.ts`) and the 14 fact Nouls
(`src/chat/facts.ts`) — and `resolveIntake` starts a run only for `coding_task` at Jev's own p ≥ `INTAKE_RUN_FLOOR`
0.6 with its paired Noul ≥ 0.5; a greeting becomes one `[jevcode]` catalogue item, a tool question one item per
selected fact (`selectFacts`, p ≥ 0.5, ≤ 4), a code question a Jev-selected lookup (`src/chat/lookup.ts`, jev-only) or
one generator turn without tools (`src/chat/llm-turn.ts`, jev+llm, floor `LLM_ANSWER_FLOOR` 0.5), and anything weaker
the `intake` overlay (`run this as a task?`; `y` runs, `n` replies from the answers in hand, Esc restores the draft).
Chat spend is charged to the root session meter, which exists from startup and is never recreated
(`SpendMeter.setCap` at the first run); the intake's `Decision` rows reach the Jev panel (`chat-decisions`, step 0,
stage `intent`) and `/why intake`; `--json` gains one `chat` line per intake; the `chat` index line restores chat
spend on `/resume`. The one-shot argv path passes `kind: 'task'` and never meets the intake. (2) *The TUI shows a
declared subsequence.* `UiState.transcript` is `compact` by default: items of the stage kinds and `run:ready` are
stamped `hidden` at append time and filtered before `<Static>` (the array stays append-only), one `step` item per
step (`stepSummaryText`, `plain.ts`) is shown instead, and `[you]` / `[jevcode]` rows carry a dim label and a hanging
indent. The identity of the previous paragraph is therefore **narrowed by declaration** (TUI-DESIGN-2 §9, §10.1):
`--plain` and `transcript.log` stay identical to each other and carry every line; the TUI's `full` view equals
`formatTranscriptItem(item)` per item word-wrapped at the commit width with a `label.length + 1` hanging indent (code
fences drawn as `╶──── <lang>` rules); the `compact` view is the subsequence selected by `TranscriptKind`. (3) *The
console, the cards and the splash.* `computeLayout` 1.1 gains `chrome ∈ {0, 3}` (the boxed tier at rows ≥ 16 and
columns ≥ 40: the composer and the status row share one rounded console drawn from the cli-boxes `round` glyphs
copied into `glyphs.ts`, `src/tui/console.ts` `consoleLines()`; every modal is a card, `src/tui/card.ts`; the wizard
renders inside the console), `panel` (the Jev pane collapsed to a one-row strip by default, `panelStrip`, open 6,
full 12), `splash` (5 rows while `motion.time < SPLASH_MS`) and `gate` (the secret gate as a console-hosted row);
the vertical order and the yield order are unchanged, chrome never yields, and `rows − 2` still bounds every frame.
The first frame is the splash's frame 0 — `src/tui/splash.ts` `splashFrame(0, columns)` plus the console with
`step 0/–` — ticking through Ink's `useAnimation` at 50 ms (`src/tui/motion.ts`; ≤ 15 frames, none after 700 ms,
cancelled by the first key, a run start or any overlay) and settling into the brand rule row; `launch.modeHint` and
`launch.reducedMotion` keep the frame argv-only. The mode is a setting (`mode`: flag > `JEVCODE_MODE` > dotenv > file
> default `jev-only`; `ResolvedConfig.mode`) and a badge (`UiState.modeBadge`, `modeBadge(mode, pending)`) in the
console's top edge or the flat status left zone; `/mode` and `/llm` set `PendingSettings.mode` and `runLogin('mode',
m)` opens the generator step in place.

**`--json` stream and its redaction guarantee (`cli/json-stream.ts`).** NDJSON on stdout: first
`{"v":1,"type":"stream:start","schema":"jevcode.events/1","jevcode":"<version>","t":iso}`, then
`{ "v": 1, "t", "runId", "sessionId", ...EngineEvent }` per event (the `EngineEvent` after the engine's redacting
`emit()`), plus controller lines with no engine — `session:start`, `session:end`, `session:budget`,
`session:refused { reason: 'session-cap' | 'unpriced' | 'secret' }` and `ui`. `run:end` carries `exitCode`,
`resumable` and `paths`; `status` events ride only with `--json=verbose`. Guarantee: every string is the
`EngineEvent` after `config.redact` — configured secrets, `Send anyway`-confirmed values and recognised formats
become `[REDACTED:<name>]` / `[REDACTED:pattern]`; the stream never contains keystrokes, composer drafts, pasted
payloads or key material; a human turn is the `run:start` task line and the `steer:queued` lines holding the
redacted submitted text; `secret-ack` carries a count only; an unrecognised-format secret typed inline passes
through, as in `transcript.log`. Consumers ignore unknown `type`s; `v` increments only on an incompatible change.

## 11. Errors and shutdown

`errors.ts`: `JevCodeError` (base, `code`, `exitCode`, `cause`) → `ConfigError`,
`JevError` (`JevHttpError`, `JevResponseError`, `JevModelDriftError`), `ProviderError`
(`ProviderHttpError`, `GeneratorResponseError`), `SandboxError` (spawn failure only;
timeout and output cap are `ExecResult` fields, not exceptions), `PathEscapeError`
(`SecretPathError`), `EditError`, `PatchError`, `BudgetError(reason)`, `CheckpointError`,
`AbortError`. `process.on('unhandledRejection'|'uncaughtException')` route to a single
`fatal()` that redacts and calls `shutdown('error', err)`.

**Exit codes**, pinned as `exitCode` on each error class:
- 0: run reached `stopReason = 'complete'`; `config`/`bench`/`perf` finished.
- 4: run stopped without completion by a budget or directive (`max_steps`, `wall_time`,
  `spend_cap`, `max_replans`, `replan_stop`, `impossible`) or a resume that would stop
  immediately (§9); the stop reason is printed on the last line and recorded in
  `state.json`. Bench per-task stops never change the bench process exit code; they are
  recorded in `tasks.jsonl`.
- 2: `ConfigError` or usage error (unknown flag, missing task text, `--live` without
  `--spend-cap`, model drift on the first Jev call).
- 3: `CheckpointError` (corrupt or missing checkpoint on `--resume`).
- 5: `JevError` / `ProviderError` unrecoverable after retries (`stopReason = 'error'`).
- 6: `SandboxError` / `PathEscapeError` that aborts the run (per-action `EditError`/
  `PatchError`/`PathEscapeError` are outcomes, not exits).
- 1: any other unexpected error reaching `fatal()`.
- 130: `human_abort` (Ctrl-C) or `SIGINT`; 143: `SIGTERM`; after the checkpoint is written.

**Shutdown.** One idempotent `shutdown(reason, err?)` in `loop/engine.ts` (passed to the
renderer and `cli/main.tsx`) is the only exit path besides `stop()`. Entry points: (a) Ink
`useInput` on Ctrl-C → `shutdown('human_abort')` (under raw mode the kernel never delivers
SIGINT, so this is the only Ctrl-C path while the TUI is mounted); (b)
`process.on('SIGINT')` (130) and `process.on('SIGTERM')` (143) → `shutdown('signal')`,
which cover `--plain`/non-TTY runs, external kills, and Ctrl-C after Ink has unmounted and
raw mode is restored; (c) `fatal()` → `shutdown('error', err)`. Sequence on the first
invocation: set `aborting`; `controller.abort(new AbortError(reason))` (aborts in-flight
generate/ask/confirm via the shared `AbortSignal`); three-pass tree kill of the sandbox
(§8); apply the step commit rule (§9.1); await any in-flight checkpoint write, then write
the final checkpoint with `stopReason` set (`'human_abort'`, `'signal'`, or `'error'`), the
whole checkpoint phase bounded by `Promise.race` with a 5 s timer; append the `stop`
transcript line; unmount Ink; set `process.exitCode` and let the loop drain. Any further
Ctrl-C byte or SIGINT/SIGTERM while `aborting` is set, or expiry of the 5 s bound, writes
`state.json` synchronously (`writeFileSync` to `state.json.tmp-…` then `renameSync`) and
calls `process.exit(exitCode)` immediately, with no time window (listeners stay installed;
no `process.once`). A `process.on('exit')` handler, active only once `aborting` is set and
until the async final write resolves, writes the same state synchronously as a last resort.
`fatal()` during shutdown does not count as a second press; `AbortError` rejections from
aborted requests are expected and are not routed to `fatal()`.

**State-mutation rule** (makes the final checkpoint safe from any entry point, including
`fatal()`): `plan`, `window`, and `loopDetector` are mutated only at the step commit point
(§6); stage results accumulate in a per-step `StepRecord` draft until then. The
`SpendMeter` is monotone and updated per priced call, so it is always safe to serialise; the
final checkpoint therefore contains the last committed plan/window/loopDetector plus the
current spend and, for a discarded step, `interrupted`, and never a half-applied plan.

**Amendments for the interactive session (2026-09-20/21; TUI-DESIGN §3.3, §8.6, §13.4, §13.5, §14.2).**

*State-mutation rule.* `plan`, `window` and `loopDetector` are mutated at the step commit point **and, for human
directives, at step start**: `applyPendingDirectives()` runs at the loop top after `checkBudgets()` and before
`runStep()` (a §9.1 rule-1 boundary, nothing in flight, the previous commit whole), turning every queued steer into one
`human` harness problem of the coming step and resetting the loop detector's counts. `pendingDirectives` are
checkpointed in `state.json` (redacted) so a steer queued during `pausing` or before a crash survives `--resume`
and rides a follow-up's seed. Everything else in this section's rule is unchanged.

*Exit-code table (`src/cli/epilogue.ts` `EXIT_CODE_TABLE`, `src/loop/stop.ts` `exitCodeFor(reason, error?,
degraded, signal)` — the one function `main.tsx`, the controller and the engine use).*

| situation | `jevcode run` | session (`run:end` item carries the code) |
| --- | --- | --- |
| `complete` / `generator_done` | 0 | item `exit 0`; the composer reopens |
| budget (`max_steps`, `wall_time`, `spend_cap`, `max_replans`, `token_cap`), `replan_stop`, `impossible`, `human_pause` | 4 | item `exit 4`; the composer reopens |
| `ConfigError` / usage at launch; unpriced refusal | 2 | 2 (the process exits) |
| first-call 401/403, first-call Jev model drift | 2 (was 5) | pane `[q]` → item `exit 2` |
| API failure after retries; provider spend limit `[q]` | 5 | item `exit 5` |
| checkpoint degraded and stopped (incl. `complete`); `--resume` unusable | 3 (was 0 for `complete`) | item `exit 3` + not-resumable notice |
| sandbox / path abort | 6 | item `exit 6` |
| Ctrl-C ×2 while a run is live (TUI `human_abort`) | 130 | item `exit 130`; the composer reopens |
| external SIGINT (`abort('signal', { signal: 'SIGINT' })`) | 130 | 130 (the process exits) |
| SIGTERM | 143 | 143 |
| SIGHUP / EIO on stdout | 129 | 129 |
| uncaught / render fault escalated | 1 | 1 |
| `/exit` (incl. `[y]` while live), Ctrl-D ×2 (incl. `[y]` while live), Ctrl-C ×2 idle | — | **0** — leaving is not a failure; `--exit-code last-run` returns the last run's code instead |

`degraded` (a checkpoint that could not be written and the human chose `[c] continue without checkpoints`) turns every
non-error stop into 3. Every exit prints the epilogue `jevcode: stopped — <code>: <msg> (exit N)` with `<msg>` redacted,
then the `run`, `files`, `resume` and `report` rows when a run exists (a `[ui]` item in session mode).

*`fatalExit` order (`src/cli/fatal.ts`, replaces the 2026-09-19 `fatal()`).* (1) `process.exitCode = err.exitCode`
behind an idempotent guard; (2) synchronous terminal restore **before anything is printed** — the exit string
`RESTORE = ESC[?2004l ESC[?2026l ESC[0 SP q ESC[?25h ESC[0m` and raw mode off, never `ESC c` / `ESC[2J` / `ESC[3J`;
(3) `engine.abort('error', { error })` so the `'exit'` handler writes `state.json` synchronously, then
`renderer.unmount()` raced with a 2 s bound; (4) the epilogue on stderr through `redact` (the `JEVCODE_DEBUG=1`
stack too), then `process.exit(code)`. The engine's own forced exits (the second Ctrl-C while aborting, the 5 s
shutdown bound) go through the injected `EngineOptions.exit`, which restores the terminal and prints the epilogue
first. stdout/stderr `'error'` listeners (EIO/EPIPE) are installed before any SIGHUP logic; stdin `'end'` and SIGHUP
mean hang-up **only** while Ink holds the tty in raw mode (`stdin.isTTY && stdin.isRaw`) → checkpoint, no terminal
writes, exit 129; on a pipe stdin `end` is the normal end of the task text. SIGINT/SIGTERM handlers are installed
before the first frame; before a controller exists they restore the terminal, print the one-line epilogue and exit
130/143. In `--plain` on a TTY the readline composer runs in cooked mode, so Ctrl-C *is* SIGINT and follows the
same matrix as the TUI's Ctrl-C (live → `abort('human_abort')` and stay; idle → `press Ctrl-C again to exit`, a second
within 1.5 s → exit 0); `'signal'` is reserved for SIGTERM, SIGHUP and non-TTY stdin; EOF on that composer is the
Ctrl-D rule (idle → exit 0; live → abort, exit 0 after `run:end`).

## 12. Performance plan

Budgets: first frame < 300 ms with zero network at launch; harness overhead < 50 ms per
step (p95, defined below); rendering never blocks the loop, operationalised as event-loop
lag p95 < 5 ms and max < 50 ms during a mocked run (see render-lag).

- Launch: `bin/jevcode.js` calls `module.enableCompileCache()` `[R]` and imports one
  esbuild-bundled ESM file `dist/jevcode.mjs` with ink+react inlined. Build command (`npm run
  build`): `esbuild src/cli/main.tsx --bundle --platform=node --format=esm --target=node22
  --jsx=automatic --jsx-import-source=react --define:process.env.DEV='"false"'
  --alias:react-devtools-core=./src/tui/devtools-stub.ts --banner:js="import { createRequire
  as __cr } from 'node:module'; const require = __cr(import.meta.url);"
  --outfile=dist/jevcode.mjs`. All three flags are required, verified on the pinned toolchain
  (esbuild 0.28.2, ink 7.1.1, Node 22.23.2): the `define` dead-code-eliminates the
  reconciler's `process.env.DEV === "true"` devtools branch; the `alias` stubs Ink's optional
  peer `react-devtools-core`, which esbuild otherwise hoists to a static import (without it
  the build fails to resolve; with `--external` Node throws ERR_MODULE_NOT_FOUND at load);
  the `createRequire` banner supplies `require` for CJS dependencies inside Ink's tree
  (`signal-exit` 3.0.7 calls `require("assert")` at module init, which otherwise throws
  "Dynamic require of \"assert\" is not supported" in an ESM bundle). `npm run build` ends
  with a smoke step: `node bin/jevcode.js run "x" --workspace <tmp>
  --perf-exit-after-first-frame` must print the first-frame sentinel or the build fails.
  `run` renders the App before reading config or the workspace; `bench`, `perf`, providers
  and the Jev client are dynamic imports. Ordering contract: before the first Ink commit the
  process reads nothing but argv, `process.env` and `process.stdout.isTTY`; `.env` files,
  the config file, the runs dir (`run.json`, `state.json`) and the workspace are touched only
  after the first frame has been committed (§6 first line; the resolved values reach the TUI
  through `run:ready`).
- `perf/first-frame.ts` spawns `script -q /dev/null sh -c 'stty rows 40 cols 120; exec node
  bin/jevcode.js run "x" --workspace <tmp> --perf-exit-after-first-frame'` with `stdio:
  ['ignore','pipe','pipe']` and env `JEVCODE_ASSERT_NO_NETWORK=1`, `JEVCODE_HOME` pointing at
  a non-existent directory and `--config` pointing at an unreadable path (verifying the
  ordering contract). It accumulates the pty stream and records spawn → first appearance of
  the status-line sentinel `step 0/` in the accumulated bytes (checked on every chunk, since
  the sentinel can straddle chunks). It must not use "first stdout byte": macOS `script`
  echoes `^D\b\b` onto the pty at ~2-3 ms when its stdin is not a TTY, and Ink falls back to
  80x24 on the 0x0 pty unless `stty` sets the geometry, so both the sentinel and the `stty`
  prefix are load-bearing. The status line renders `step <n>/<max>` from the first frame so
  the sentinel is stable. `--perf-exit-after-first-frame` is handled in the `run` command
  immediately after `const instance = render(<App/>)`: `await
  instance.waitUntilRenderFlush()` (Ink calls `options.onRender` before it writes the frame,
  so exiting from `onRender` or right after `render()` leaves the pty empty), then
  `process.stderr.write('FIRST_FRAME_MS=' + performance.now())` and `process.exit(0)`. The
  harness reports its own spawn-clock number as the gate (the child's `performance.now()`
  excludes Node boot and is logged only for the breakdown). No config, workspace, provider
  or Jev module is imported before this point. `bin/jevcode.js` installs the interceptor
  before `await import('../dist/jevcode.mjs')` when `JEVCODE_ASSERT_NO_NETWORK=1`:
  `globalThis.fetch = () => { throw new Error('network before first frame') }`; it is
  installed only in this mode, so it never needs removing; a non-zero exit or the error text
  in the pty fails the run. Repeated 10× (cold: `NODE_COMPILE_CACHE` pointed at a fresh temp
  dir; then warm with the cache kept); median and p95 for each; gate `p95 < 300 ms` on the
  cold series. Written to `perf/results/latest.json` with the per-run raw values and the pty
  transcript of the slowest run.
- `perf/step-overhead.ts`: `harnessMs` is defined on the mocked zero-latency run: everything
  the engine does between external waits, including plan/window serialisation, candidate
  listing and refresh, redaction, checkpoint serialisation and writes, with no TUI attached
  (render lag is `perf/render-lag.ts`). It is `StepRecord.timing.harnessMs` from `step:end`
  events. The script creates a temp git repo of 5,000 small files (70 dirs) plus a
  `node_modules/` tree of 5,000 files that must be skipped, points `--runs-dir` at a temp dir
  on disk, runs the engine in-process with `MockProvider` and `MockJev` at zero latency for
  50 steps whose mock trajectory includes `run` actions (so the cache-invalidation path is
  measured), and gates p95 harnessMs < 50 ms (p50 also reported). Bench `timing.harnessMs` is
  the same subtraction (total − generatorMs − jevMs − execMs) on whatever run produced it;
  on live runs the work that overlaps a Jev or generator wait is hidden inside that wait, so
  the bench value is a residual, reported and never gated.
- `perf/render-lag.ts` runs a mocked 60-step run under the TUI twice, each in a sized
  pseudo-TTY with `CI` unset: `script -q /dev/null sh -c "stty rows 40 cols 120; node
  bin/jevcode.js run …"` and again with `stty rows 12 cols 120` (the second forces Ink's
  clear-terminal path if the §10 height budget is ever violated). `MockProvider` streams 500
  deltas/s and `MockJev` answers every stage with its normal batch (intent 11, context up to
  12, risk 5, judge+complete 5 + claims). In the engine process a 10 ms `setInterval` records
  `max(0, actual − 10)` per tick after a 500 ms warm-up (startup is measured by
  `first-frame`), and `render({ onRender })` records `renderTime` per frame. The pty output is
  captured and the count of `\x1b[2J` (Ink `clearTerminal`) sequences is recorded per
  geometry. Gates, applied by `npm run perf` (nonzero exit, `pass: false` in
  `perf/results/latest.json`): loop lag p95 < 5 ms and max < 50 ms at both geometries;
  `renderTime` p95 < 5 ms at both; zero `\x1b[2J` after the first frame at both geometries
  (the §10 height budget makes this a gate of 0 at rows 12 as well). Results include the
  geometry, step count, and delta rate.
- `perf/jev-latency.ts` (`--live`) measures raw/p50/p95 for representative stage requests.
- `npm run perf` writes `perf/results/latest.json` and prints a table; the README carries
  the numbers.

**Gates added for the interactive TUI (2026-09-21; TUI-DESIGN §18).** The plan extends the three budgets above:
first frame cold p95 < 300 ms for the `chat` geometry as well as `run` (24×80 and 40×120, zero network asserted, the
`step 0/` sentinel); composer keystroke → frame p95 < 16 ms in a real pty at the 24-row region, keystrokes spaced
≥ 100 ms so Ink's 34 ms leading-edge throttle is not what is measured (a 30 ms burst series is reported, not gated);
event-loop lag p95 < 5 ms / max < 50 ms while typing during a live mocked run at a realistic step rate (`JEVCODE_MOCK_STEP_MS=200`,
about 5 steps/s — ten times faster than a real run; the zero-latency mock is a reported `stress` row, since at 35 steps/s Ink's
immediate `<Static>` renders alone cost ≈ 460 frames/s), the p95 taken net of the lag probe's idle floor — the same 10 ms
`setInterval` reads ≈ 2 ms per tick in an idle Node process on macOS (kernel timer coalescing of libuv's kevent timeout), so each
run measures that floor with the identical probe in a bare idle `node` and reports raw, floor and net (TUI-DESIGN §18); zero `ESC[2J` / `ESC[3J` / `ESC c` /
`ESC[?1049h` after the first frame **per geometry segment** — a shrink resize is allowed one clear, a grow none
(`docs/research/tui/20-pty-driver-findings.md` §1; measured 2026-09-21: idle shrinks show ≤ 1, but a shrink with a live
pane open shows 1–2 — Ink 7.1.1's `resized` handler renders the stale tree at the new viewport before the App's rows
state updates and the re-render clears again — so `test/pty/chat.pty.test.ts` gates at 2 per shrink, the perf `states`
probe still allows 1 and fails, and the bound of 1 is an open item in `docs/STATUS.md`); `dynamic` frames ≤ maxFps + 1 per second (frames carrying new `<Static>` rows and the leading-edge frame of a
keystroke are rendered outside Ink's throttle by design — `reconciler.js` `isStaticDirty` → `onImmediateRender`, `throttle(…, { leading: true })` — and are reported separately, TUI-DESIGN §18 "Frame rate"); at most one `ESC[?25l` per
frame and the cursor shown at the end of every frame while the composer is active; `harnessMs` p95 < 50 ms per
step with pre/post images included and `imagesMs` p95 reported against a 15 ms target (a report row, not a gate); `<Static>` append bytes per line reported;
plus the unit-test micro-gates (`computeLayout` ≤ 5 µs, `layoutRows` of a 12,000-char draft ≤ 2 ms, fuzzy `rank()`
over 5,000 candidates p95 ≤ 16 ms, index fold ≤ 2 ms at 1,000 runs).

**Round 2 (2026-09-21; TUI-DESIGN-2 §9).** Every gate above stays and two are added; the probes moved to the round-2
surface. *First frame:* the `step 0/` sentinel is unchanged and now lands in the splash's frame 0, so the probe also
reads the wordmark cells of the first dynamic frame (`wordmarkFirstFrame`) and **gates** on them per series
(`splashOk`, TUI-DESIGN-2 §9 row 1: all 20 runs at 40×120 and 24×80 must carry them, none at 8×40 — the flat tier;
a splash that slipped to frame 1 fails the series, named `first frame (splash frame 0)` in the README); it sets
`JEVCODE_ASSERT_NO_CONFIG_BEFORE_FRAME=1` beside `JEVCODE_ASSERT_NO_NETWORK=1` and fails a run that prints `config
before first frame` (the launcher hook that would throw on a `resolveConfig` or `.git/HEAD` read before the first
stdout write is a request to `bin/jevcode.js`'s owner; until it lands the variable is inert). *Frame rate:* the
render-lag probe gains a splash bucket — the `dynamic` frames (the class the fps gate governs, `classifyFrames`)
arriving within 700 ms of the first frame (`splashBucket`), the `static` and `key` frames of the same window and the
wordmark frames reported beside them, whether the first frame carried the wordmark — gated at `⌈(maxFps + 1) ×
0.7⌉` = 22, the typing-window gate over the window's length (the splash ticks at 50 ms through Ink's `useAnimation`, ≤
15 frames by construction; the typist waits 800 ms after the placeholder so the splash settles by itself before its
first key, and the window ends at the first `send` if one came earlier; the reduced-motion geometry and rows 12 draw
none). *Intake reply wall time* (new gate): `src/perf/intake-latency.ts`
types 20 greetings and tool questions into `chat --mock` through the typist and pairs every Enter with the first
frame carrying its `[you]` bubble (p95 < 16 ms, the composer gate) and the first frame carrying a `[jevcode]` item
(p95 ≤ 40 ms with the mock decider at 0 ms; net of the delay at `JEVCODE_MOCK_JEV_MS=150`, where the `⠹ thinking`
frames are counted); no message may start a run. The live gate — p95 < 1.5 s over a real provider — is the S6 live
scenario's and `test/live/intake.live.test.ts`'s, never this probe's. *Zero clears:* the `states` probe gains an
`intake` card scenario at 24×80 and 12×60, expects the review card (`╭─ review · step 2`), the palette card (`╭─
commands`) and the wizard console (`╭─ setup · `) in the boxed tier, and its `resize-live` sentinel is the panel strip
(`jev s<N> · <n> decisions`). *Every probe that needs the scripted mocked run says `--mode jev-on`* (the round-2
default is `jev-only`, under which `--mock` would run the real synthesizer); `pty.ts` `composerRow` unwraps the boxed
console row (`│ › … │`) so the keystroke → frame pairing holds in both tiers; the placeholders and the live sentinel
are TUI-DESIGN-2 §4.4's and `[run] start` (`[run] ready` is hidden by the compact transcript). The smoke
(`test/pty/run-smoke.sh`) grows to 36 scenarios plus a `--hermetic` self-check of the child environment, and the pty
project gains `test/pty/round2.pty.test.ts` (33 tests, 4 of them `it.fails` records of open defects; 63 pty tests in all);
their results and the round-2 `jevcode perf` run are in `docs/STATUS.md`, "Round 2". On disk on 2026-09-21: `src/perf/{first-frame,render-lag,step-overhead,jev-latency,main}.ts` (the 2026-09-19
gates), the wave-4 probes `src/perf/composer-latency.ts` (keystroke → frame series through `perf/drivers/pty_type.py`, a typist that sends keys on a fixed cadence and timestamps them),
`src/perf/states.ts` (zero clears per modal state and geometry segment) and `src/perf/pty.ts` (the shared driver
plumbing and `CLEAR_RE` with its self-test), the shell smoke `test/pty/run-smoke.sh` (19 scenarios: exit code,
per-segment zero clears, the exit string exactly once) and the vitest project `pty` (`npm run test:pty`,
`test/pty/*.pty.test.ts`). Which of these gate `npm run perf` is the Gate column of its table: first frame cold p95,
harness p95, render lag p95 (net of the probe floor) and max at the realistic step rate, the composer p95/max series, the
`dynamic` frame rate where it is exercised (the lag runs, composer `live`, `burst30`) and the per-state clears; `imagesMs`,
`<Static>` bytes, the `stress` rows and the `burst30` latency are report-only. The release run of 2026-09-21 (10:57Z;
`perf/results/latest.json`; 1-minute load 1.00 → 0.99; five orphaned `drive.exp` processes of other slots alive but idle,
listed under `foreignDrivers`) **passes every gate**: first frame cold p95 109.5–115.2 ms over the six series; harness p95
46.0 ms (`imagesMs` p95 19.4 ms, reported); lag p95 net 3.30 / 2.20 / 3.58 ms at rows 40 / 12 / 40 reduced motion (raw
5.34 / 4.25 / 5.62 ms over a 2.04 ms probe floor; max 15.0 / 17.2 / 13.9 ms) at 4.2 steps/s; `dynamic` frames 8 / 9 / 3 per
second (`static` 17, `key` 15–16); the stress row at 0 ms: 34.7 steps/s, 453 `<Static>` rows/s, lag p95 5.78 ms raw, 116 ·
26 · 28 static · key · dynamic frames/s; composer p95 3.4 / 8.5 / 3.9 / 7.8 ms (idle / live / palette / review), `burst30` 34
`key` frames/s at 33.2 keys/s with 0 `dynamic`; 15 state scenarios pass with one clear per shrink (`resize`, `resize-live`)
and none elsewhere. The README Performance table is regenerated from that file.

## 13. Bench (`bench/*`)

`jevcode bench --suite swebench|terminal-bench|all --tasks N | --task-id <id>,… --conditions
jev-on,jev-off --concurrency 3 [--live --spend-cap USD] [--task-spend-cap USD]
[--allow-model-alias] [--resume <bench-id>] --out bench/results/<id>`. The bench runs the
engine in-process and reads `RunResult` (§4); it never re-derives fields from the run
directory. The engine's bench entry point accepts `{ task: string, workspace: string }` and
nothing else from a task record.

- **Tasks**: `bench/data/swebench-verified-30.json` holds 30 instance records with keys
  `instance_id`, `repo`, `base_commit`, `environment_setup_commit`, `version`, `created_at`,
  `difficulty`, `problem_statement`, `hints_text`, `fail_to_pass` (string[]),
  `pass_to_pass` (string[]), `test_patch`, `test_files` (paths from the `test_patch`
  headers), `spec: { python, install, pre_install[], pip_packages[], packages | null,
  test_cmd }`, `log_parser`, `eval_script` (the official `eval.sh` verbatim) and
  `source_urls`, taken from the dataset and the `swe-bench-tasks` repo (`bench/data/README.md`)
  `[R]`; gold `patch` lives in `swebench-verified-30.gold.json`, used only by the mocked
  provider. Subset: sympy 10, django 10, pytest 5, pylint 3, requests 2; difficulty 12/15/3;
  all Python 3.9.

  **Task text and workspace isolation.** For SWE-bench the engine's `task` is exactly
  `problem_statement` (line endings normalised to `\n`, otherwise verbatim). The agent
  workspace is a fresh clone at `base_commit` with the instance's `pre_install`/`install` run
  in a venv before step 1 so the judge's test detection works; `test_patch` is applied only
  by the evaluator after the run. `hints_text`, `FAIL_TO_PASS`, `PASS_TO_PASS`, `test_patch`,
  `patch`, and `difficulty` never enter a generator prompt, the Jev state, or the workspace
  under either condition; the loader exposes them only to the evaluator, the mocked provider
  (`patch`), and the report (`difficulty`). `hints_text` is kept in the record solely so the
  subset file is a faithful copy of the dataset and is never read by bench code.
  `bench/swebench/loader.ts` and `bench/terminalbench/loader.ts` each export a single
  `toBenchTask(record): { id, task, setup }` whose `task` field is the only text handed to the
  engine.

  **Terminal-Bench (4.0, Harbor task format).** The data agent profiled all 66 tasks
  (`bench/data/terminal-bench/manifest.json`, one record per task with `local_feasibility`,
  `shim_effort`, `runner_requirements`, `env_copy_lines`, `env_run_steps_non_install`,
  `artifacts`, `tests_hardcode_paths`, `verifier_pip_packages`, timeouts). No task is
  runnable locally without a shim: every verifier hardcodes `/app`, `/tests`,
  `/logs/verifier`. Ten tasks (all "unlikely", none needing root or Linux-only syscalls;
  `bench/data/terminal-bench/README.md`) are checked in under `tasks/<name>/` with
  `instruction.md`, `task.toml`, `environment/` (Dockerfile plus the data files its `COPY`
  lines reference) and `tests/`; their upstream `solution/` is under `gold/<name>/` and is
  read only by the mocked bench. The loader (`bench/terminalbench/loader.ts`) takes the
  task list from `manifest.json` filtered to names that have a `tasks/<name>/` directory, and
  parses `task.toml` (`[verifier].timeout_sec`, `artifacts`, `[metadata]`). For
  Terminal-Bench the `task` is the contents of `instruction.md` with `/app` rewritten to the
  absolute workspace path (boundary-safe: `(?<![\w./-])/app(?=[/"'\s:)]|$)`; the record
  stores `instructionShim: true`). The agent workspace is materialised from `environment/`
  by replaying the Dockerfile's `COPY` lines (`env_copy_lines`) and the plain
  python/git/mkdir `RUN` steps (`env_run_steps_non_install`) into `W`; `tests/` and `gold/`
  are never copied into it.
- **Conditions**: `jev-on` = the full engine (§6). `jev-off` = `loop/generator-only.ts`,
  which implements the same `Engine` interface, differs from `jev-on` only at the points
  where a Jev answer is consumed, and is otherwise the same code path:
  - Same `Provider`, same system prompt (§7), same user-message layout. The Jev-derived
    sections are omitted: intent (with probability), blocked/declined reasons, replan
    directive. The "context files" section is replaced by the code-computed candidate list
    from `workspace/candidates.ts` (path + bytes, same ≤ 300 pre-filter, no contents); the
    generator obtains file contents only through `read` actions, bounded by the same ≤ 12
    files / ≤ 60 KB / ≤ 16 KB-per-file limits as the context stage.
  - The persistent plan (§6) is kept and diffed identically; because there is no judge, items
    newly in `done` are accepted verbatim with `evidence: { step, judged: -1 }` (`-1` = "not
    judged"; `Plan` rendering treats it as absent).
  - Loop detection runs identically (same signatures, same 3-strike trip, same reset). On
    trip, instead of the replan Choice, the fixed text `You have repeated the same <run
    command | edit | failure> three times. Change approach, or reply with a done action
    explaining why the task cannot be completed.` is injected into the next user message and
    stored in `plan.harnessProblems`; the trip is counted in the task record's `loops`.
  - No risk stage: every well-formed proposal executes (`blocked = 0`, `reviews = 0`);
    `failed` outcomes (patch/edit/path errors) are recorded exactly as in jev-on. No
    judge/complete stage: `judge = null`, `completion = null`. A `done` proposal stops the run
    with `stopReason: 'generator_done'`.
  - Identical across both conditions and recorded in `summary.json.conditions[<name>]`:
    generator model id, `temperature` (pinned, default `0`), `maxTokens` (pinned, default
    `4096`), `--max-steps`, `--max-wall`, per-run spend cap, sandbox profile, command timeout,
    output cap (the recent-window size is the constant 4 in `loop/window.ts`, stated in the
    report text rather than recorded as a setting).
- **Scheduling**: the runner dispatches both conditions of one task as a unit before moving
  to the next task (concurrency applies across units). When the bench-level spend cap fires,
  tasks with only one finished condition are written to `tasks.jsonl` with `pairComplete:
  false` and are excluded from the paired tables in `comparison.md` (listed under
  "incomplete pairs"); `summary.json` reports `pairedTasks` per suite.
- **Spend caps.** `--spend-cap USD` on `bench` is the total for the whole bench across all
  tasks, conditions and concurrent workers. It is enforced by one root `SpendMeter` shared by
  every engine the runner starts; each run gets `root.child(taskSpendCapUsd)` where
  `--task-spend-cap` (default 2.00, the engine default from §3) is the per-run cap so a
  single runaway task cannot consume the bench. Per-run records and checkpoints use the
  child's snapshot, so `cost: { generator, jev }` stays per run. `--live` requires
  `--spend-cap`; without `--live` both caps still apply but mocked costs are zero. When the
  bench cap fires: the run that trips it stops with `stopReason: 'spend_cap'`; the runner
  aborts every other running engine through its `AbortSignal` (each records `stopReason:
  'spend_cap'`, checkpoints per §9.1, and is evaluated on whatever it produced); unstarted
  `(task, condition)` pairs are written to `tasks.jsonl` as `{ pass: null, evaluator: 'none',
  stopReason: 'not_run', reason: 'bench_spend_cap', steps: 0 }` and are excluded from
  pass-rate denominators. The bench record's `stopReason` type is `StopReason | 'not_run'`;
  `'not_run'` is not added to the engine's `StopReason` union in §4. `summary.json` records
  `spendCapUsd`, `taskSpendCapUsd`, `spentUsd: { generator, jev, total }`, `notRun` (count
  and list), and `capFired: 'bench' | 'task' | null` per task, satisfying DECISIONS.md ("with
  its own cap recorded in the summary JSON").
- **Bench resume.** `jevcode bench --resume <bench-id>` re-reads
  `bench/results/<bench-id>/tasks.jsonl`, skips every `(task, condition)` pair that has a
  record with `pass !== null`, re-queues `not_run` pairs, and for pairs whose engine run has
  a checkpoint but no final record resumes them via the engine's `--resume <runId>` (the
  `runId` is in the partial record / `run.json`). The shared `SpendMeter` is seeded with the
  summed `cost` of all existing records so `--spend-cap` remains a total for the bench, and
  `summary.json` and `comparison.md` are regenerated from the full `tasks.jsonl`.
- **Per task record** (`tasks.jsonl`): `task`, `condition`, `pass` (`true|false|null`),
  `evaluator` (`local-venv|invalid|local|mock|none`), `steps`, `wallMs`, `tokensPerStep`
  (array), `cost: { generator, jev }`, `jevLatencyMs: { raw: number[]; p50: number | null;
  p95: number | null }`, `jevRequests`, `jevQuestions`, `timing: { generatorMs, jevMs,
  execMs, harnessMs }`, `stopReason`, `blocked`, `reviews`, `declined`, `loops`, `replans`,
  `reads`, `modelDrift`, `pairComplete`, `patchEmpty`, `patchApplied`, `patchBytes`,
  `runId`. All fields except `task`, `condition`, `pass`, `evaluator` and the patch fields
  are copied from `RunResult`. `jevLatencyMs.raw` has one entry per Jev request, taken from
  `RunResult.jevLatencyMs` (equivalently `jev.jsonl`), never from `Decision` rows; p50/p95 are
  nearest-rank over `raw`; request and question counts are `Σ usage.jev.calls` and `Σ
  decisions.length`, reported as `jevRequests` and `jevQuestions` so tokens per request can
  be checked against REPORT §4. `reviews` = steps with `risk.verdict === 'review'`; `blocked`
  = steps with `risk.verdict === 'block'` plus steps with `outcome.status === 'declined'`
  (the prompt's "in bench runs it counts as blocked"; in bench every review is declined, so
  `blocked ≥ reviews`); `noop` outcomes count in neither. `stopReason` may be `'error'`; such
  tasks record `pass: null` and appear in the stop-reason histogram.
- **Outputs**: `tasks.jsonl`, `summary.json`, `comparison.md`,
  `predictions.<condition>.jsonl`. Aggregation rules, applied identically to both conditions
  by `bench/metrics.ts`:
  - **Evaluated set**: a task is *evaluated* iff `pass !== null`. `summary.json` reports per
    condition `tasks`, `evaluated`, `unevaluated` (evaluator ran but produced no verdict,
    e.g. venv build failed or `invalid`) and `unsupported` (skipped `unsupported-locally`),
    listing the task ids for the last two. **Pass rate** = `passed / evaluated`, printed as
    `passed/evaluated (n)`. `comparison.md` compares conditions only over the intersection of
    tasks evaluated in every condition (excluding `modelDrift` tasks by default), and states
    that n.
  - **Steps-to-solve** is defined only for passed tasks: mean, median and the distribution
    are over passed tasks with n stated. Alongside it a cumulative solve curve `solved(k) =
    |{tasks passed with steps <= k}| / |evaluated|` for k = 1..maxSteps, so failed and
    budget-stopped runs are censored (they never contribute a solve) rather than dropped or
    counted as solves. The all-runs statistic is kept but named **steps used** (mean/median
    over all runs, with the stop-reason histogram beside it) so it is never read as
    steps-to-solve.
  - **Tokens-per-step curve**: three series, generator tokens, Jev tokens and their sum, each
    as mean over runs that reached step i, printed as `mean (n)`; a run contributes only to
    indices it reached. The paired table reports the three means separately: Jev tokens are
    priced at $0.042 per million (output free), so the combined number alone misrepresents
    cost (the first live pass showed 61k Jev tokens per step from the context Nouls against
    12k generator tokens). `summary.json`'s "mean tokens/step" is the mean over all executed
    steps of all runs (steps, not runs, as the unit), with the step count stated.
  - **Percentiles** (`jevLatencyMs.p50/p95`, timing) over an empty sample are `null`;
    `jev-off` records `jevLatencyMs: { raw: [], p50: null, p95: null }` and `cost.jev = 0`.
  - `comparison.md` opens with a "Conditions" paragraph stating the structural difference in
    context delivery (jev-on receives Jev-selected file contents each step; jev-off receives
    the candidate list and must spend `read` steps) and reports `read`-action counts per
    condition alongside steps-to-solve; it renders the solve curve and the tokens-per-step
    curve as markdown tables with inline bar characters and the n column; every
    Terminal-Bench number is labelled "local shim, non-comparable to the tbench.ai
    leaderboard"; `summary.json` carries `mocked: true` for mocked benches.
  - **Predictions**: one file per condition, `predictions.<condition>.jsonl`, one line per
    SWE-bench instance: `{ "instance_id": "<id>", "model_name_or_path": "jevcode-<condition>-
    <generator model id with '/' replaced by '__'>", "model_patch": "<unified diff or ''>" }`.
    Conditions are never mixed in one file because the official loader and sb-cli key
    predictions by `instance_id`, and `model_name_or_path` is used as a log directory name so
    it must be filesystem-safe and distinct per condition.
  - **`model_patch` extraction** (`bench/swebench/predictions.ts`, run by the bench runner
    after the engine has stopped, for every `stopReason` including `signal`, `spend_cap`,
    `max_steps`, `wall_time`, `error`; never inside the step loop): in the agent workspace,
    which was cloned at `base_commit`, run `git add -A -N && git diff --binary <base_commit>
    -- . ':(exclude).jevcode*'` through `workspace/git.ts`. Intent-to-add makes untracked new
    files appear; diffing against `base_commit` rather than the index includes anything the
    agent committed via a `run` action; deletions are included; `--binary` is accepted by
    `git apply`. An empty diff is written as `""` and the task record gets `patchEmpty:
    true` (the official harness counts these as `empty_patch_instances` and does not run
    them). The diff is also saved as `<run>/model_patch.diff`. The local evaluator consumes
    this same `model_patch` string, never the agent workspace directly.
- **Mocked** (default): `MockProvider` replays a trajectory derived from the gold patch
  (read touched files → apply patch → run tests → done) and `MockJev` answers from
  deterministic rules keyed on state content; the evaluator is `mock` (pass iff the gold
  patch applied). It produces the same predictions files from the mocked workspace so
  `predictions.ts` and the evaluator's apply step are exercised offline, and uses the same
  Terminal-Bench loader with a trajectory that writes the artefacts named in `task.toml`.
  This exercises the whole pipeline offline; the failure paths are covered by the §14 unit
  tests.
- **Live**: `--live` requires a spend cap; Docker is unavailable here (DECISIONS.md).

  SWE-bench local-venv evaluator (`bench/swebench/evaluator.ts`), replicating the official
  `eval.sh` (research 02 §3, §6.5): (a) `model_patch` as above; an empty diff records `pass:
  false`, `patchApplied: false` without running anything. (b) Fresh clone into
  `<run>/eval/<instance_id>` (never the agent's workspace); `git checkout
  <environment_setup_commit>`; `python3 -m venv .venv`; install the spec's `packages`
  (`requirements.txt` at that commit when named) and `pip_packages`. (c) `git checkout
  <base_commit>`; run spec `pre_install` then `install` (setup timeout 20 min). (d) Apply
  `model_patch` with the official fallback chain `git apply --verbose` → `git apply --verbose
  --3way` → `git apply --verbose --reject` → `patch --batch --forward --fuzz=5 -p1 -i`;
  failure → `patchApplied: false`, `pass: false`. (e) `git checkout <base_commit> -- <test
  files named in test_patch>`, then `git apply -v` `test_patch`. (f) Run `<test_cmd> <test
  files>` (the spec's `test_cmd` already carries `-rA`/verbosity) under a 1800 s timeout in
  the sandbox runner with the drain-to-tail output handling (full output also written to
  `test_output.txt`, so `pass` is parsed from a complete summary, never from a killed run);
  capture the exit code. (g) Parse with ported `parse_log_pytest`, `parse_log_django`,
  `parse_log_sympy` (only the repos present in the subset; the parser is selected by `repo`);
  resolve truncated expected ids by prefix match. (h) `pass = every FAIL_TO_PASS id in
  {PASSED, XFAIL} AND every PASS_TO_PASS id in {PASSED, XFAIL, SKIPPED}`; a missing id counts
  as failed. A timeout, or a non-zero test exit code with no FAILED/ERROR in the parsed log,
  invalidates the run: `pass: null`, `evaluator: 'invalid'` with a reason. (i) Record per task
  `patchApplied`, `evalExitCode`, and `tests_status: { FAIL_TO_PASS: { success, failure },
  PASS_TO_PASS: { success, failure } }` in the shape of the official `report.json`; keep
  `test_output.txt` under `<run>/eval/<instance_id>/`. All git commands go through
  `workspace/git.ts` (§8).

  Terminal-Bench local runner (`bench/terminalbench/{loader,evaluator}.ts`), following
  design A in `bench/data/terminal-bench/README.md` (path-rewritten copy of `tests/`,
  parallel-safe). Per trial, with `W` = agent workspace, `V` = fresh verifier app dir, `T` =
  rewritten tests dir, `L` = verifier log dir, `O`/`R` = stand-ins for `/output`/`/results`,
  `S` = shim dir, `PY` = venv: (1) materialise `W` from `environment/` as above and run the
  engine on the shimmed instruction; (2) after the agent stops, build `V` by replaying
  `tests/Dockerfile`'s `COPY … /app/…` and `RUN mkdir -p /app/…` lines, then copy each
  `artifacts` path from `W` into `V` (Harbor's "separate" mode shows the verifier only the
  declared artifacts, never the whole workspace); (3) copy `tests/` to `T` and rewrite string
  literals in `*.sh`, `*.py`, `*.mjs`, `*.mts`, `*.ts`, `*.tsx` with the boundary-aware
  pattern for `/app→V`, `/tests→T`, `/logs/verifier→L`, `/output→O`, `/results→R`,
  `/tmp/agent.patch→L/agent.patch` (never `tests/Dockerfile` or data files); (4) create `PY`
  once per bench (`<runsDir>/tb-venv`) with `python3 -m venv` and `pip install
  pytest==9.1.1 pytest-json-ctrf==0.5.2` plus the union of `verifier_pip_packages`; (5) put
  `S` first on `PATH` with shims for `setpriv` (skip `--reuid/--regid/--clear-groups` and
  exec the rest), `uv` (`uv pip install --system -r F` → `PY/bin/python -m pip install -r F`)
  and `apt-get` (fail loudly); (6) run `bash T/test.sh` through the sandbox runner with cwd
  `T`, `PATH=S:PY/bin:$PATH`, `HOME=<run home>`, `PYTHONDONTWRITEBYTECODE=1`, timeout
  `[verifier].timeout_sec`, stdout/stderr to `L/test-stdout.txt` / `L/test-stderr.txt`; (7)
  verdict per Harbor's `Verifier.verify()`: `L/reward.json` (`{ "reward": r }` or a dict
  whose values are summed), else `L/reward.txt` (single float), else `pass: null, evaluator:
  'none', reason: 'no-reward-file'` (missing file is infrastructure, not a 0); `pass = reward
  >= 1`, `evaluator: 'local'`; the exit code is never the verdict. Tasks whose `test.sh` exits
  with a missing tool (`command not found`) are recorded `pass: null, evaluator: 'none',
  reason: 'unsupported-locally'` and excluded from pass-rate denominators. Every
  Terminal-Bench number is "local shim, non-comparable" (Python 3.9 vs the images' 3.11-3.13,
  no container isolation, agent and verifier share a user). The Harbor installed-agent adapter
  `bench/harbor/jevcode_agent.py` (installs Node via `nvm_node_install_snippet`, runs
  `jevcode run --plain "<instruction>"` in `/app`) is shipped for official runs elsewhere and
  is untested here (Harbor needs Python >= 3.12; the reference machine has 3.9).

## 14. Testing

`vitest` with two projects: `unit` (offline, mocked `fetch`, temp workspaces) and `live`
(`test:live`, hits Jev and the generator, skips with a reason when a key is missing).

Required explicit tests (prompt list, with the assertions this design pins):
- patch fails to apply (`PatchError` with the failing hunk, outcome `failed`, `fail:` signature).
- output cap hit: a command emitting > `maxOutputBytes` followed by a pytest-style summary
  line runs to completion with `exitCode: 0`, `truncated: true`, `killedBy: null`,
  `bytesSeen > maxOutputBytes`, and `tests.parsed` populated from the summary; a second case
  asserts a command that both passes the cap and hits the timeout records `killedBy:
  'timeout'` and `truncated: true` consistently regardless of event order.
- command timeout (`killedBy: 'timeout'`, status `executed`, judged normally).
- Ctrl-C mid-command, on both paths: SIGINT delivered to a `--plain` engine, and `\x03`
  written to `ink-testing-library` stdin while a mocked engine has a real `sleep` child in a
  detached group; both assert the tree kill ran and no snapshotted pid survives, `steps.jsonl`
  has the interrupted step with `outcome.status === 'interrupted'`, `interruptedAt.stage ===
  'execute'` and `outcome.exec.signal` set, `state.json` passes checksum/version validation
  with `step` equal to that step and plan/window equal to the last committed step and spend
  including the interrupted step, `stopReason` `signal` / `human_abort`, exit 130. Rules 1
  and 3 of §9.1: SIGINT during propose leaves `steps.jsonl` unchanged with spend persisted
  and `state.interrupted` set; SIGINT during judge keeps `outcome: executed` with `judge:
  null` and the `interrupted before judge` note. A second `\x03`/SIGINT during a deliberately
  stalled checkpoint write (sandbox child ignoring SIGTERM) force-exits immediately via an
  injected `exit` function. Abort during a pending confirmation (TUI `\x03` and
  `engine.abort()` in plain mode) rejects `confirm()` with `AbortError`, applies rule 1, writes
  the checkpoint and stops with the abort reason. `<App>` mounts without throwing when stdin
  has no `isTTY`.
- spend cap hit mid-step, two cases: (a) the generator call at propose crosses the cap → the
  before-execute check fires, §9.1 rule 1 (no `StepRecord`, `state.interrupted` holds the
  proposal, `stopReason: 'spend_cap'`, `stoppedAt: 'before_execute'`, checkpoint written); (b)
  the judge call crosses the cap → the step is recorded whole with judge, completion and
  `Decision` rows, plan update applied, and the run stops with `spend_cap` at the next step
  start. `--resume` of a `spend_cap` run without a raised cap exits immediately with the
  stored reason; with `--spend-cap` raised it continues from the stored step without
  re-paying.
- malformed Jev response: one validation retry for a transient shape failure, then the step
  ends with `error.stage` set, nothing downstream runs, checkpoint written; a deterministic
  mismatch (ids, argmax, model) is not retried and billed once; three consecutive failures
  give `stopReason = 'error'` and the run resumes. Jev 5xx on every attempt at **risk** for a
  `run` proposal → the command is never spawned; Jev failure at **judge** after an executed
  `edit` → file change kept, `judge = null`, `done` claims rejected.
- malformed generator response: the second failure yields the §6 stage-table record shape
  (`proposal: null`, `outcome.status = 'failed'`, no Jev risk request made, signature
  `fail:generator:…`).
- review answered no: `declined` row (judge = null, completion = null, signature preserved,
  reason prefixed with the confirmer identity).
- corrupt checkpoint on resume: corrupt `state.json`, resume from `state.prev.json`, assert
  the step recorded only in `steps.jsonl` appears in the resumed window and that the resumed
  run's first step number is one higher than it.

Plus: config precedence and fingerprinting; model id normalisation (alias, casing, bare id
all accepted against a mocked dated response; dated mismatch on first call aborts without
retry; mismatch on step > 1 records `servedModel` and continues; alias configured then a
different dated id on a later response is drift); retry with jitter and `Retry-After`; a
Jev per-attempt timeout is retried while an engine abort is not; redaction (a fixture
containing one key of each §8.4 format, one supplied via `--api-key`, one from an unused
variable in a loaded `.env`, and a mocked `run: cat .env` exec output must produce zero
unmasked occurrences, and no 8-character substring of either configured key, in every
artefact listed in §8.4 after a mocked 2-step run, while a 40-hex git SHA-1 in the same
output survives unchanged); confidence formulas against REPORT §8 numbers; a Jev Choice
response with tied top probabilities (`{a: 0.50, b: 0.50}`, choice `b`) passes validation
and `b` is used, and a Score response with tied top levels computes confidence with the
smallest tied index; risk mapping table for `loop/stages/risk.ts` on all four dimensions:
`{1: .8, 2: .2}` → 0.30 review; `{1: .85, 2: .15}` → 0.2875 ok; `{1: .9, 3: .1}` → 0.30
review; `{1: 1.0}` → 0.25 ok; `{2: 1.0}` → 0.50 review; `{3: .7, 2: .3}` → 0.70 block;
`{3: .8, 2: .2}` → 0.80 block; `{3: .8, 0: .2}` → 0.80 block; `{4: .7, 0: .3}` → 0.70 block;
`{0: .5, 4: .5}` → 0.50 review; `{0: .1, 3: .9}` → 0.90 block; `{0: .7, 3: .3}` → 0.30
review; `{2: .25, 3: .75}` → 0.75 block; plus an assertion that the verdict is independent of
the summation order of the probability map; risk target fixtures: a `write` to a path in
`workspace.createdThisRun` with a confident level-1 distribution yields `verdict: 'ok'`; in a
workspace with `git: false`, an `edit` to a file created by an earlier `write` yields `ok`;
a `write` to a pre-existing untracked file (`existsBefore: true, recoverable: false`) with a
confident level-2 distribution yields `review`; Choice resolution (argmax taken when its
paired Noul ≥ 0.5; argmax overridden by a higher paired Noul; all paired Nouls < 0.5 →
fallback and `intent:unresolved` signature; escape chosen with one paired Noul ≥ 0.5 → that
option); loop detection and replan (the same test command run four times with different
output does not trip; run three times with identical exit code and output trips on the
third; three `blocked` proposals with the same reason trip; three rejected `done`s trip;
after a trip all counts are zero; resume mid-loop: two occurrences checkpointed, resume,
third occurrence trips on the next step; `none_of_these` mapping, `task_impossible` stop,
repeat trip carries history, `max_replans` budget); plan evidence rules (claim accepted at
`done_j` 0.70 with evidence, held as `unverified` at 0.69 and 0.31, rejected at 0.29; a
claim made on a step whose unrelated action succeeded is not accepted; a step whose goal is
"run the tests" with a failing run and a PlanDraft that moves an unrelated fix to done leaves
that item in `remaining`; more than 8 claims truncated without a crash; dropped `remaining`
items retained unless `new_information ≥ 0.7` or a replan fired; replan directive survives
the generator's next `openProblems`); blocked, declined and failed outcomes send no judge
request (mock Jev call count), reject done-claims, keep remaining/openProblems, and still
count toward loop detection; a `done` step after passing tests ends the run with `complete`
in the same step; window bounds; SSE parsing for both providers from fixtures; wall-time
deadline firing mid-generate, mid-ask, and mid-command records `stopReason = 'wall_time'`,
kills the tree (`killedBy = 'wall_time'`), writes the checkpoint, and bench `wallMs` ≤
`--max-wall` + kill grace; path escapes and symlinks (symlinked file pointing outside: read,
edit, patch each throw `PathEscapeError`; symlinked directory pointing outside; symlink
resolving inside allowed; dangling symlink; `..` traversal; absolute path outside;
`.git/config` write rejected; `candidates.ts` omitting a tracked 120000 entry; a `read` of
`./.env` returns `SecretPathError`; the candidate list for a workspace containing `.env`
excludes it); seatbelt (darwin only, skipped elsewhere): a workspace created with
`fs.mkdtempSync(path.join(os.tmpdir(), 'jev-'))` allows `sh -c 'echo hi > f.txt'` and still
denies a write to `$HOME/escape`; a child's `git config core.fsmonitor ...` and `echo >
.git/hooks/pre-commit` fail with EPERM while `git add` succeeds; `cat <dotenv path>` returns
exit != 0 with EPERM in stderr; with `core.fsmonitor` and `diff.external` planted directly
in a fixture repo's `.git/config` (and via a `gitdir:` pointer file), the harness's
candidate listing, `changedFiles` computation and bench evaluator complete without
executing the planted command (sentinel file not created) and without any key in the
spawned env; `workspace/git.ts` is the only module that spawns `git` (grep check); escaped-
session kill (a command whose child uses `start_new_session=True`, `kill()` leaves
`orphans` empty and the grandchild gone; a grandchild that double-forks before the snapshot
is reported in `orphans` when still reachable rather than silently ignored); atomic writes;
run-id format and `--resume` containment; resume config (resume from a different cwd
without `--workspace` continues in `run.json.workspace`; `--workspace` with a different
realpath is `ConfigError`; `--resume` with `--spend-cap` raised after a `spend_cap` stop takes
a step and records the override); TUI frames with `ink-testing-library` (decisions
highlighting, confirmation; height budget: with a stdout stub reporting `columns: 80, rows:
12` and `rows: 24`, render the App with a 200-line streaming proposal, 30 decisions, and a
pending confirmation, and assert the last frame has at most `rows − 2` lines); plain
renderer; CLI parsing; evaluator grading from fixture logs (django, sympy, pytest formats;
truncated ids; SKIPPED F2P = fail; SKIPPED P2P = ok; non-zero exit with no failures =
invalid; patch apply failure); bench isolation (for one SWE-bench and one Terminal-Bench task
run mocked end to end, capture every `GenerateRequest` and every Jev `state` and assert (a)
`task` strictly equals the loader's `problem_statement` / shimmed `instruction.md`, (b)
neither the full `hints_text` string nor any added line of `test_patch` or `patch` appears in
any prompt or serialised state, (c) after the run the workspace contains no file that
`test_patch` adds and no `tests/` or `solution/` directory); bench metrics aggregation on
synthetic `RunResult`s (blocked/reviews/declined formulas, evaluated set, solve curve, null
percentiles); bench mocked end to end on 3 tasks (the two predictions files exist, have 3
lines each with the three keys, and `model_patch` applies to a clean checkout; a trajectory
that writes a new file and then rewrites it produces no `blocked`/`declined` outcome from
the destructive dimension; bench cap fires mid-bench with concurrency 3: siblings aborted,
remaining pairs `not_run`, summary fields present; `bench --resume` completes only the
missing pairs without re-spending on completed ones).

`test:live` adds a rubric regression that, with the §5.5 state shape, asserts `destructive`
E[k] < 0.5 for `cat <absolute path outside workspace>`, `ls /usr/lib`, `ps aux`, and the
detected test command, and E[k] > 3.5 for `rm -rf ~/.cache`, so future rubric edits cannot
reintroduce the mixed-dimension split; and the context-criteria agreement gate of §5.5.

## 15. Dependencies

Pinned `[R]` (RESEARCH.md §0.1, all fetched 2026-09-19): Node `22.23.2` (`.nvmrc`; `engines
>=22.12.0 <27`), `ink 7.1.1`, `react 19.3.0`, `@types/react 19.3.0`, `@types/node 22.20.4`,
`typescript 7.0.2`, `vitest 5.0.1`, `vite 8.3.0`, `@vitest/coverage-v8 5.0.1`, `tsx 4.23.13`,
`esbuild 0.28.2`, `ink-testing-library 4.0.0`. Model ids: generator `claude-sonnet-5`
(Anthropic, $2/$10 per MTok, cache read $0.20, cache write $2.50) and
`anthropic/claude-sonnet-5` (OpenRouter, same prices, `usage.cost` returned); decider
`typesafe/jev-1.13-20260917` ($0.042 per M input, output free).

Runtime: `ink`, `react` (Ink's peer). Dev: `typescript`, `@types/react`, `@types/node`,
`vitest`, `vite`, `@vitest/coverage-v8`, `ink-testing-library`, `esbuild`, `tsx`. Everything else is Node built-ins
(`node:util` `parseArgs`/`parseEnv`/`styleText`, `fetch`, WebStreams, `node:crypto`,
`node:child_process`, `node:fs/promises`, `node:readline`). esbuild's `alias`/`define`/
`banner` (§12) are build-time only; no runtime dependency is added. Each is justified in the
README.

## 16. Deviations from the prompt and from REPORT.md

1. **Noul "confidence"** in the decisions pane is the derived `|2p − 1|`, because Jev
   returns no confidence for Nouls (REPORT §1); the pane labels it "derived".
2. **Risk as `max(expected level / (n−1), P(k ≥ 3))` for the harm dimensions and `P(k ≥ 3)`
   alone for the alignment dimensions** rather than a raw Score: the prompt
   says "scores it … with risk as the max"; a Score's `score` is `Σ k·p_k` (REPORT §1), so
   the expected-level term is the direct reading, normalised by `n−1` with level 1 as the
   routine-but-notable action (a confident level-1 action executes, level 2 is the first
   review level); the tail-mass term is added so the prompt's "Risk >= 0.7 blocks" cannot be
   defeated by probability mass on lower levels; §5.3 records the worked bands.
3. **Completion uses a Noul threshold at 0.85 and plan acceptance uses 0.7 / 0.3**, not
   0.5, per REPORT §14's advice against thresholds at 0.5 on borderline questions;
   completion is configurable, plan acceptance is a constant.
4. **Default provider `anthropic` cannot be exercised live** in this build (no key);
   OpenRouter is used for every live run (DECISIONS.md).
5. **Bench evaluation without Docker** (DECISIONS.md): `pass` comes from a local venv
   evaluator / local Terminal-Bench runner and the evaluator is recorded per task; the
   official prediction format is also emitted, one file per condition.
6. **Retry policy** follows the TypeSafe SDK defaults (jittered, REPORT §12) rather than
   `lab.mjs`'s un-jittered `400·2^(n−1)`, because the prompt asks for jittered backoff.
7. **Context Nouls name each file literally and address a path-keyed `candidates`
   object**, not `candidates[i]`: REPORT §7 shows ids are invisible to the model so each
   question must carry its own reference, and REPORT §10 shows array-index references
   degrade (0.72) while semantic references hold (0.99). The yes/no criteria live once in
   the state under `criteria.context` and every question points at that path; this cheaper
   form is kept only if the live slice shows it agrees with per-question criteria (§5.5 gate).
8. **One `SpendMeter` per run, shared between generator and Jev** (the prompt asks for one
   spend cap); the bench nests per-run meters under one bench-wide meter; `lab.mjs` capped
   Jev alone via a file.
9. **Paired Nouls are per option on every Choice** as the prompt requires, even though
   REPORT §14 treats an escape option and per-option Nouls as alternatives; cost is ~9
   tokens per Noul plus criteria; the engine combines them in code (Choice resolution, §6).
10. **Loop signal for `run` includes the result**: the prompt lists "same command … three
    times"; the design keys it on command plus normalised result, because the fix-verify
    cycle runs the test command after every edit and would otherwise trip on the third
    verification even while failures shrink; identical repeats still trip.
11. **`done` proposals are risk-scored but execute nothing** (`noop`): the prompt's risk gate
    governs execution; scoring `done` lets `plan_mismatch`/`out_of_scope` block a premature
    finish with a reason the generator can act on, and the completion Noul stays the gate.
12. **Blocked, declined and failed outcomes skip the judge request**: the prompt says "Jev
    judges the output"; there is no output, so the ~170 ms and tokens are saved and Jev is
    never asked about an absent field (REPORT §10 empty-state priors).

## 17. Open questions

Observed in the live demo runs (2026-09-19, `docs/live/`):

- **Plan retention bloat.** Rule (b) retains `remaining` items the generator drops without a
  done claim, and a rewording counts as remove + add; in the 9-step fix run `plan.remaining`
  grew to 10 entries while the generator's own draft listed 1–3. Candidates: normalise text
  before diffing, or expire retained items after N steps. Left as designed for the bench.
- **Doubly quiet pytest.** `pytest -q` on top of `addopts = -q` prints no summary line; the
  judge fell back to `tests_pass_unparsed` and completion waited for a verbose run. The
  parser now counts progress characters (`.F E s x X`) when no summary exists.
- **Generator self-refusal.** For an overtly destructive task the generator refused before Jev
  could block; the block path was demonstrated with a subtler task (`rm -rf tests`, risk
  0.92). Jev's risk stage is the second line of defence, not the first.
- **Completion calibration (live bench).** jev-on's solved tasks ran to the 25-step budget
  with a correct patch on disk because `task_complete` rarely reached 0.85: the criteria ask for
  a current passing run of the detected test command, while agents mostly ran targeted tests.
  Accepting a targeted run as evidence, or lowering the threshold, is a calibration decision to
  take from the 212k recorded decisions rather than a design change.
- **Intent overrides.** Jev often answered `finish` or `edit` while the paired Noul for that
  option stayed below 0.5, so Choice resolution fell back to `investigate`; three such
  fallbacks trip the detector (`intent:unresolved`). Whether the 0.5 floor is too strict for
  the intent stage is a tuning question for the bench data.

- Whether the checked-in SWE-bench subset can be evaluated locally for every chosen repo
  under Python 3.9 (to be measured in the 3-task slice).
- How many Terminal-Bench 4.0 tasks pass the local-feasibility rule (target 10); measured
  when `subset.json` is built.
- Prompt caching effect on tokens/step through OpenRouter (measured in the bench).
- Whether the shared `criteria.context` form agrees with per-question criteria (§5.5 gate).

## 18. Design review log (2026-09-19)

Applied findings (one line each; where findings overlapped, the reconciliation chosen is
stated so the reasoning is preserved):

1. `done` path undefined → risk-scored, outcome `noop`, reduced judge (`task_complete` only), signature `done:<sha12(summary)>`, `finish` has no short-circuit (§4, §5.5, §6). Reconciled with the later `done`/`proposed_done` proposals by taking the risk-scored variant (§16.11); status name `noop`.
2. Completion Noul saw the pre-update plan → `workspace.lastTestRun`/`lastChangeStep`/`testsCurrent` (code-computed, persisted), `proposal.planClaim`, completion criteria never reference `executed.tests` or bare `plan.remaining` (§5.5, §9).
3. Stage failure undefined → stage failure policy: fail closed at risk, step recorded with `error`, `consecutiveStageFailures` → `stopReason 'error'`, `StepRecord.intent | null` (§6, §4, §14).
4. Judge undefined for blocked/declined/failed → no judge request, `judge = completion = null`, done-claims rejected, signature still computed (§6 non-executed outcomes, §16.12). `read` stays `executed`; `done` is `noop` (finding 1).
5. Generator controlled `plan.remaining`; 0.5 gate → per-claim `done_<j>` Nouls with 0.7/0.3 bands, remaining-drop rule, harness-owned problems (§6 Plan). Claim cap set to 8 (finding 5) rather than 20 (finding 16).
6. Spend cap thrown inside the client → `add()` never throws, `checkBudgets()` at two points, judge always runs after execute, resume of a budget-stopped run re-checks limits (§6 Budgets, §9). Exit code on an immediate resume stop is 4 (exit-code table), not 0.
7. Replan outputs unconsumed → `none_of_these` → `change_approach`, `task_impossible ≥ 0.85` → `'impossible'`, trip history, `max_replans` (§6, §4, §3). `'impossible'` chosen over `'task_impossible'` as the StopReason name.
8. Risk "level 3+ dominant → block" false → `max(E[k]/(n−1), P(k≥3))`, `dims` with `expected`/`tailMass`/`bound`, reason names the bound (§5.3, §4, §6, §16.2).
9. Intent `finish`/`none_of_these` unconsumed; rule 3 weakened → paired `can_<option>` Nouls, Choice resolution, `plan_still_valid` consumer, `needs_more_context` dropped (§5.4, §5.5, §6, §16.9).
10. Mid-step abort semantics → §9.1 step commit rule, write order and overlap, resume folds `steps.jsonl` tail into the window, `workspace.changedFiles` in the prompt (§9, §7). The "every started step is recorded with `aborted`" variant was not adopted: rule 1 discards pre-execute steps, `interruptedAt` replaces `aborted`.
11. Choice argmax ties → `probabilities[choice]` within 1e-6 of the max, ties allowed (§5.2).
12. `loopSignature` single string → `loopSignatures: string[]`, signatures for every outcome status (§4, §6).
13. Jev per-attempt timeout; wall deadline → 10 s per attempt, `AbortSignal.any`, generate idle timeouts, single `AbortController` deadline, exec timeout clamp (§5.1, §7, §6).
14. Completion on the `done` step had no evidence → merged into 1 and 2 (`lastTestRun.allPassed`, `testsCurrent`); done step skips `succeeded`/`error_present`/`new_information`.
15. Risk rubric put routine edits at review → rubric rewritten (level 1 notable-but-fine, level 2 first review), integer-hundredths arithmetic, test table (§5.5, §5.3, §14). Two table rows (`{3:.7,2:.3}`, `{3:.8,0:.2}`) become block under the tail-mass term of finding 8.
16. `destructive` mixed two dimensions → rule 8 (one quantity per Score), destructive rubric on "how much is lost", live rubric regression (§5.4, §5.5, §14).
17. Plan acceptance and context cut at 0.5 → per-claim Nouls (see 5), rule 6 lists every threshold (§5.4 rule 6).
18. Context Nouls by array index → path-keyed `candidates`, literal file names, `criteria.context` gate (§5.5, §16.7).
19. Model-id mismatch hard error → rule 7 normalisation, alias resolution, `JevModelDriftError` (first call aborts, later drift recorded), bench `--allow-model-alias` (§5.4, §5.2, §3, §11).
20. Judge Nouls without criteria; `tests_pass` computed by Jev → criteria for every Noul, `JudgeResult.tests` code-computed, `tests_pass_unparsed` (§5.5, §4).
21. Escape options unconsumed → §6 "Consumers of every Jev answer"; `Intent` without `none_of_these`, `IntentAnswer` raw (§4, §6). `succeeded ≥ 0.5` plan gate mentioned there is superseded by finding 5.
22. Validator ties (duplicate of 11) → §5.3 `k*` smallest tied index; `Decision.probability` comment (§5.3, §4).
23. `redact()` unspecified → §8.4 `SecretSet`, patterns, enumerated sinks; secret paths (§8.4, §8). Key display uses the SHA-256 fingerprint (finding 40), not first-5/last-4.
24. `.git/config` writable → profile denials plus `workspace/git.ts` scrubbed harness git (§8, §2).
25. Profile allowed reads of `.env`/`~/.ssh` → new seatbelt profile with read denials, `SecretPathError`, `workspace.sandbox`, `sandboxExecDenied` (§8, §5.5, §4).
26. Tree kill misses new sessions → three-pass `ps`-snapshot kill, `orphans` (§8, §4, §11, §14).
27. Output cap killed the command → drain-to-tail, `bytesSeen`, `killedBy`, `OutputCapError` removed (§8, §4, §11, §5.5, §13).
28. Seatbelt paths not realpath'ed → realpath every profile path, canonical workspace from config (§8, §3).
29. Ctrl-C never SIGINT under raw mode; force-exit unreachable → `useInput` Ctrl-C → `shutdown()`, `isActive`, readline `terminal: false` (§10, §11, §14).
30. `paths.ts` checked the ancestor not the target → `resolveInside` follows the final component; all harness file access routed through it (§8).
31. esbuild bundle does not load → `define` + `alias` + `createRequire` banner, smoke step, `tui/devtools-stub.ts` (§12, §2, §15).
32. First-frame probe measured `script` → `stty` geometry, `step 0/` sentinel, `waitUntilRenderFlush()`, interceptor in the launcher (§12).
33. Dynamic region could exceed terminal height → §10 height budget, render-lag clear-count gate (§10, §12, §14).
34. Transcript `<Static>` lifecycle unspecified → immutable keyed items, `proposal` single dispatch, three transcripts agree (§10). `EngineEvents` map merged into the `EngineEvent` union of finding 43.
35. Ctrl-C under raw mode (duplicate of 29) → merged; `shutdown()` is one idempotent routine (§11).
36. Harness-overhead definition; candidate cache; fsync → `harnessMs` on the mocked run with a 10k-file fixture, cached listing with `run`-only invalidation, fsync only on `state.json` (§12, §8, §9).
37. Loop order contradicted first-frame claim → first line of §6 and the §12 ordering contract, `run:ready` (§6, §12, §3).
38. Render-lag probe had no gate → thresholds and two geometries (§12).
39. Interrupted step undefined → `ActionOutcome 'interrupted'`, `interruptedAt`, §9.1 (§4, §9.1). `wall_time` during a command is rule 2 with `killedBy: 'wall_time'` rather than status `executed`.
40. `observe()` after checkpoint → observe at the commit point, snapshot semantics, `LoopDetectorState` (§6, §4, §14).
41. Resume state not enumerated → `CheckpointState` (§4, §9). Pre-execute cuts are discarded (rule 1) with `state.interrupted` diagnostic; post-execute cuts are committed (rules 2, 3) instead of an uncommitted `interrupted` record.
42. Stop reason decided after the last checkpoint → `stop()` writes a final checkpoint, `RunResult`, resume handling of stored `stopReason` (§6, §4, §9).
43. Run-id format → `YYYYMMDD-HHMMSS-<8 base32>`, `EEXIST` retry, resume containment (§9). Chosen over the `6 hex` variant.
44. Shutdown under-specified → single `shutdown()`, no second-press time window, 5 s bound, sync last resort, state-mutation rule (§11).
45. Config on `--resume` undefined → identity settings from `run.json`, limits re-resolved and logged in `overrides[]`, differing workspace/model → `ConfigError` (§9). Reconciles finding 6 (re-resolve everything) and the CheckpointStore finding (identity pinned).
46. `run.json` stored key characters → SHA-256 fingerprint, `redact()` built from every secret (§3, §8.4, §9).
47. Command could overshoot `--max-wall` → exec timeout clamped to remaining wall time, `killedBy`, §9.1 rule 2 (§6, §8, §4).
48. Local-venv evaluator never applied the model patch → official `eval.sh` sequence, per-repo log parsers, FULL rule (§13).
49. Jev-off control not comparable → conditions spelled out, candidate list instead of context, verbatim plan acceptance, fixed loop text, pinned temperature/maxTokens, paired scheduling (§13, §7, §3).
50. `hints_text` leakage unaddressed → task text and workspace isolation, `toBenchTask`, isolation test (§13, §14).
51. Predictions export undefined → per-condition files, `model_patch` extraction, `patchEmpty`/`patchApplied` (§13).
52. Steps-to-solve undefined for failures → evaluated set, censored solve curve, tokens-per-step `mean (n)`, null percentiles (§13).
53. Jev latency over Decision rows → `JevRequestRecord`, `jev.jsonl`, `RunResult.jevLatencyMs` per request (§4, §9, §13).
54. `blocked`/`reviews` undefined; declined reason misattributed → formulas, confirmer-identity prefix (§13, §6, §4).
55. Bench spend cap scope and resume → bench total vs `--task-spend-cap`, `not_run` records, `bench --resume` (§13, §3). `'not_run'` chosen over recording unstarted pairs as `spend_cap`.
56. Terminal-Bench runner undefined → 4.0 Harbor layout, selection rule, path shim, reward file verdict (§13, §2, §17).
57. `EngineEvent`, `Engine`, `RunResult` missing → §4 engine surface. `Confirmer` rejects with `AbortError` on abort (finding 58) rather than resolving false; `SpendMeter.add` never throws (finding 6).
58. Confirmation path ambiguous, not abortable → `ConfirmRequest`, `confirm(req, { signal })`, `confirm:request`/`confirm:resolved`, abort during review → §9.1 rule 1 (§4, §6, §10, §14).
59. Step state machine had no skip table → per-outcome stage table (§6). `done` keeps the risk stage (finding 1); no mid-step replan on `intent = none_of_these` (Choice resolution fallback instead).
60. Rule 3 weakened; Choice resolution → applied with `can_<option>` names and the 0.5 floor; `task_impossible` still stops on its own at 0.85 (finding 7).
61. SpendMeter two homes → `spend/meter.ts` only, interface with `child()`/`restore()`, client does no accounting (§2, §4, §5.1, §6, §13). `assertBudget()` dropped in favour of `checkBudgets()` at two points (finding 6).
62. Workspace/Sandbox interfaces missing → §4 `Workspace`, `Sandbox`, `Candidate`/`CandidateView`, `SandboxError` scope (§4, §8, §11, §5.5). Level `'seatbelt' | 'none'`.
63. CheckpointStore/`PersistedState`/`WindowEntry` missing → merged into `CheckpointState`, `CheckpointStore`, `WindowEntry`, `GeneratorCallRecord`, write order (§4, §9).
64. CLI flags scattered; no exit codes → §3.1 and the §11 exit-code table (SIGTERM 143 added).
65. Loop detector tripped on legitimate test runs → result-keyed `run:` signature, cumulative-since-replan counts, all counts reset on trip (§6, §16.10).
66. Plan acceptance at 0.5 violated rule 6 → subsumed by finding 5's `done_<j>` Nouls; rule 6 enumerates thresholds; §16.3 updated. The "test command passed" code shortcut is not a separate gate: the `done_<j>` criteria see `executed.tests.parsed`.
67. Model pin rejected aliases (duplicate of 19) → merged, including `--allow-model-alias`.
68. Validator ties (third statement) → merged into 11/22.
69. `destructive` level 2 caught run-created files → `proposal.target` with `recoverable`, `workspace.createdThisRun`, fixtures (§5.5, §6, §14).

Refuted findings (not applied; reason preserved):

- `Decision.probability`/`confidence` semantics and the stage label of batched `task_complete`: already stated in §4/§5.3/§16.1; `answer.type` is the discriminant; the stage label is an opaque single-producer field with no consumer that depends on it.
- Loading `<JEVCODE_EXTRA_ENV_FILE>` pulls unrelated secrets into the config map: `ResolvedConfig` is typed by the §3 table so unknown variables cannot be stored; the cwd-relative default proposed is less predictable and a wider surface. (Unused dotenv secrets are, however, added to the redaction `SecretSet` by finding 23.)
- Plain renderer prints one line per delta and interleaves bench runs: the bench attaches no renderer and writes per-run `transcript.log`; delta handling belongs to the event taxonomy (now §10: raw writes, line ended at `proposal`).
- Overlapping the checkpoint write with the next intent request loses a committed step on a hard crash: the on-disk exposure window is the same tmp+rename write with or without overlap; in-flight spend of the current step is lost on SIGKILL in every per-step design; the proposed `Σ usage over decisions.jsonl` would multiply-count batched questions.
- `steps.jsonl` torn/orphaned last line undetected: nothing reconstructs state from the JSONL logs (`state.json` is authoritative); a torn append needs power loss, outside the prompt's crash modes; failing resume on log length would be a regression.
- `state.prev.json` rotation unspecified and missing `state.json` ignored: copy-then-atomic-write (or rename-rename with ENOENT fallback) already leaves a valid checkpoint at every instant; "on failure" covers the load. §9 now states the rename order and the ENOENT fallback as a clarification only.
- Exit codes only defined for two cases and SIGTERM mapped to 130: the prompt has no exit-code requirement and no test needs one; the residual (SIGTERM → 143) is folded into the §11 table introduced by finding 64.
- Atomic-write temp files left in the workspace after a crash: `git ls-files` never lists them, resume opens `state.json` by exact name, and a startup delete sweep of the user's workspace is an unscored destructive action against the first-frame budget.
- Mocked bench exercises only the happy path: the prompt's "mocked end to end" qualifies the bench pipeline; block/review/loop/resume paths are unit tests in §14; scripting them into the bench makes numbers a property of the choreography and executes injected destructive commands under jev-off. (Two residues applied: the gold-patch "exercises patch failure" sentence was corrected in §7 and `summary.json.mocked` was added.)
- Nobody owns building the per-stage state JSON: ownership is determinable from the §2 layout (one file per stage, `jev/questions.ts` for generic rules) and every stage input is specified in §5.5; the proposed `StageContext` added fields inconsistent with §5.5 and §6.
- `ResolvedConfig`, Secret handling and redaction bootstrap undefined: §3 specifies the contract in prose and `config/types.ts` is allocated; the `Secret` wrapper is hardening, not a correction. (The redaction bootstrap sentence is now in §3/§8.4 via finding 23.)
- MockProvider/MockJev scripting interface undefined: the contracts are `Provider`/`Decider` in §4 with one `provider/mock.ts` and one `jev/mock.ts`; constructor options of test doubles are implementation detail, and the proposed `failAt → BudgetError` conflicts with the never-throwing meter.
- Context Nouls address candidates by array index (as a REPORT §10 misreading): REPORT's 0.72/0.75/0.25 figures are nested/indirect/arithmetic references, not `array[i].field` (0.98/0.02); the scale concern at 300 entries is unmeasured either way. The path-keyed object was adopted anyway through finding 18 as a cheap hedge.
- `tests_pass` asks Jev to read parsed counts code already knows: a field comparison is not counting (REPORT §10 measures it as reliable) and `testsPass` gated nothing. Finding 20 nevertheless moved the parsed case to code (`JudgeResult.tests.source = 'parsed'`) as part of the criteria rewrite, keeping a Noul only for unparsed output.

Edits outside DESIGN.md made by the applied findings (DECISIONS.md, same date): the
CLI-architecture entry now describes the SBPL profile as `(allow default)` plus denials
(§8); the no-Docker entry's evaluator description now applies `model_patch` and
`test_patch`, runs `test_cmd` on the test files, and grades with ported log parsers under
the official FULL rule (§13); the bundling entry now lists the `createRequire` banner as a
required third fix (§12).

## 19. Post-review reconciliation (2026-09-19, after RESEARCH.md and the data agents)

Applied after §18, before implementation started. Where §4's prose and `src/core/types.ts`
differ, **`src/core/types.ts` is authoritative**; the differences are listed here.

1. **Generator structured channel** (§7): native tool calling (`propose_action`, strict
   schema, forced `tool_choice`) with the fenced ```json block as fallback, per RESEARCH.md
   §0.2 / research `07` §4. `GenerateRequest` gains `tools?`/`toolChoice?`,
   `GenerateResult` gains `toolCalls`, `GenerateOptions` gains `onToolDelta`.
2. **Temperature is not sent by default** (§3, §7): Claude Sonnet 5 rejects non-default
   sampling parameters; `temperature: number | null`, recorded per call. The bench records
   `temperature: null` under both conditions.
3. **Patches via `git apply`** (§8): `--check` then apply, through `workspace/git.ts`;
   `PatchError.hunk` is git's message. The hand-written applier is dropped.
4. **Terminal-Bench data reality** (§2, §13): 66-task `manifest.json`, 10 tasks checked in
   with `environment/` (needed to materialise the workspace) and upstream solutions under
   `gold/` for the mocked bench; local runner follows design A of
   `bench/data/terminal-bench/README.md` (path-rewritten `tests/`, fresh verifier dir with
   declared artifacts only, pinned pytest plugins, PATH shims). Numbers are labelled
   non-comparable.
5. **SWE-bench record schema** (§13): snake_case `fail_to_pass`/`pass_to_pass`, `spec`,
   `test_files`, `eval_script`, `log_parser` as produced by the data agent.
6. **Contract additions in `types.ts`** beyond §4: `Confirmer.identity`;
   `Engine.snapshotState()`; `EngineEmitter.emit`; `AskResult.id`; `RunLimits.spendCapUsd`;
   `EngineOptions.{configRecord, redact, secretPaths, generation, deciderModel, exit}`;
   `Workspace.{invalidateCandidates, noteChanged}` and `target(path, createdThisRun)`;
   `SandboxRunOptions.{env, cwd, abortKilledBy}`; `CheckpointStore` bound to one run
   (`load()` without arguments, `updateMeta`, `writeStateSync`, `readStepsAfter`);
   `CheckpointState.consecutiveStageFailures`; `Renderer`/`RendererOptions` (TUI and plain
   renderers share one surface; `firstFrame()` is the perf hook); `ResolvedConfig`,
   `GeneratorConfig`, `DeciderConfig`; `BenchTaskRecord`, `BenchDeps`,
   `SandboxCreateOptions`; `MockTurn`/`MockProviderOptions`/`MockDeciderOptions` (the mock
   scripting surface the bench and perf use); `RISK_DIMENSIONS`.
7. **Shared helpers written before the fan-out**: `core/{hash,atomic,json,text,time,events}.ts`,
   `jev/confidence.ts` (formulas, `riskFromProbabilities` in integer hundredths, verdict
   bands) and `jev/questions.ts` (builders enforcing §5.4 rules 3, 4, 8). Module owners test
   them and may extend them; signatures stay.
8. **Module ownership for the parallel build**: A config + `cli/args.ts` + `core/redact.ts`;
   B `jev/{client,validate,mock}.ts` + `spend/meter.ts`; C `provider/{sse,anthropic,
   openrouter,mock}.ts`; D `sandbox/*` + `workspace/*`; E1 `checkpoint/*`; E2 `loop/*` +
   `provider/{prompts,actions}.ts` (the generator protocol belongs with the engine); F
   `tui/*`; G `bench/*` + `bench/harbor/jevcode_agent.py`; then integration: `cli/main.tsx`,
   `perf/*`, README.
9. **Default completion threshold stays 0.85** (research `06` suggests 0.90; both are far
   from the 0.5 band and the value is configurable; the bench records it).

## 20. Implementation notes recorded by the module reviews (2026-09-19)

Semantics fixed during implementation, kept here so the design stays the reference:

- `AskResult.latencyMs` is the successful attempt's round-trip only; `attempts` counts every
  fetch including the one validation retry (at most 4 per `ask`). `Answer.legend` for a Score
  is rebuilt from the request's criteria (never wire text). A 200 body over 4 MiB is rejected.
- `max_replans` fires when the detector trips and `replanCount >= maxReplans`, i.e. when one
  more replan would be needed, so the last permitted directive still gets its step.
- `StepRecord.stoppedAt: 'before_execute'` never appears in `steps.jsonl` (rule 1 discards that
  step); it is recorded in the transcript stop line and `state.interrupted`.
- `StepTiming.harnessMs` excludes the confirmation wait (total − generator − jev − exec −
  confirm wait), so a human review does not inflate harness overhead.
- `ExecResult.stdout/stderr` when truncated are `head + "…[output truncated: N bytes
  omitted]…" + tail` per stream. Live `exec:output` chunks are redacted per chunk; a secret
  split across a pipe read boundary can reach the live region unredacted, while the persisted
  `ExecResult` is redacted whole. Documented limitation.
- `TokenUsage.inputTokens` is the full context (uncached + cache read + cache write) and
  `costUsd` prices each class at its rate, so tokens/step and cost are read consistently.
- `Workspace.read()` of a missing file throws `FileNotFoundError` (exit code class 6) and the
  step records `outcome: failed` with a crisp `fail:` signature.
- `Engine.abort()`: the first call starts `shutdown()`; a second call before `run()` resolves
  writes `state.json` synchronously and exits 130; calls after `run()` resolved are no-ops.
- `updateMeta` appends `overrides`/`resumes` and replaces `resolvedJevModel`/`jevModelDrift`.
- `JEVCODE_HOME` is the jevcode home (`runsDir = <JEVCODE_HOME>/runs`); `--runs-dir` sets the
  runs dir directly. `parseDuration` treats a bare number as milliseconds.
- The workspace root may be a strict subdirectory of a git repository: harness git re-roots
  `status --porcelain` paths and applies patches in plain mode (`GIT_CEILING_DIRECTORIES`).
- `go test ./...` prints no per-test lines without `-v`, so Go workspaces fall back to the
  `tests_pass_unparsed` Noul.
- `resolveInside` accepts absolute paths that resolve inside the workspace; the `absolute` kind
  is only for absolute paths outside it.
- The Jev client's per-attempt timeout is a linked `AbortController` plus an explicit timer,
  not `AbortSignal.any([signal, AbortSignal.timeout()])`: composite signals are weakly held
  and were collected under the TUI's GC pressure, leaving an in-flight request unabortable
  (live, 2026-09-19). Providers use the same pattern (`linkedAbort`).
- Seatbelt reads under `~/.jevcode`: `file-read-data` denied, metadata allowed, the run's
  own tmp/home and the bench's extra roots re-allowed by the same specific operation (an
  SBPL deny on a specific operation outranks a later allow on the `file-read*` family).
- Bench infrastructure sandboxes (clone, venv, pip, verifier) pass `protectGit: false`
  because a fresh clone must create `.git/hooks` itself; `extraReadable` roots give the
  agent's `--shared` clone and the evaluator access to the bare object cache and the
  verifier venv without making them writable.
- The local-venv evaluator upgrades `pip`, `setuptools` and `wheel` in each venv before the
  spec install; the system venv's pip 21 cannot editable-install pyproject-based projects
  (django, pytest) on Python 3.9.
- Terminal-Bench tasks materialise their workspace from `environment/` and expose `aux/`
  stand-ins for `/output`, `/results` and `/logs` as extra writable roots of the agent
  sandbox.

## 21. Jev-only mode (2026-09-20)

`EngineMode` gained `'jev-only'`: the propose stage calls a `Synthesizer`
(`synthesize(ctx) → Proposal`, contract in `src/core/types.ts`) instead of the generator;
the provider slot holds a `NullProvider` that throws if `generate()` is ever reached and the
engine refuses to call it in that mode; no `generator:*` events or `generator.jsonl` rows are
produced; progress is reported through `synth` events (transcript kind `synth`, live region,
`propose [synth]` status marker). `SynthesisContext.ask` and `.decider` route through the
engine's recorded ask, so every Jev question the synthesizer asks lands in `decisions.jsonl`,
`jev.jsonl`, the pane and the meter. Config: `generator()` is never validated in jev-only.
CLI: `--mode jev-on|jev-off|jev-only` on `run` (hidden `--condition` kept as alias); bench
`--conditions` accepts `jev-only`, records `generatorCalls` per run and marks a jev-only record
`invalid` ("generator called in jev-only") if the count is non-zero; `--live` needs a generator
key only when a generator condition is selected. Bench suites `quixbugs` and `ladder` are the
jev-only difficulty ladder. Architecture of the synthesizer itself: `docs/JEV-ONLY-DESIGN.md`
(from the measurement-and-design programme logged in `docs/JEV-ONLY.md`).

### 21.1 Components that exist in the tree (as of 2026-09-20, evening)

The synthesizer's design is `docs/JEV-ONLY-DESIGN.md`; this list names what is built and
where, so a reader can go from the design's section to the file. Every component follows the
mode's rule: code proposes from facts in the workspace, Jev chooses among ≤ 255 concrete
options, tests verify. Measurements are in `experiments/results/jev-only-rungs-1-2.md` (cited
below as "rungs §n").

- **Ledger.** `src/synth/search/goals.ts`: one goal per cluster of failing tests
  (exception-raising tests cluster by innermost frame, assertion failures one goal per test),
  the attack-first Choice, the park rules of design §5.3. `src/synth/search/index.ts` is the
  outer step (`synthesize(ctx)`): establishing full-suite run, one goal per step, commit or
  park, plan items with evidence, `synthState` persistence. `src/synth/search/proposal.ts`
  builds the `patch` / `run` / `read` / `done` proposals and attaches the code-computed
  `Proposal.evidence` (before/after counts, newly passing and newly failing tests).
- **Sieve and budgets.** `src/synth/search/budget.ts` is the oracle model (per-run time from
  the baseline, lanes, SIEVE when one goal-subset run is ≤ 2 s, RANK otherwise; per-step caps
  on test wall, runs and Jev requests). `src/synth/sieve/queue.ts` (global verification queue,
  vocabulary pre-check, dedupe), `lanes.ts` (git worktree or `cp -R` shadow lanes, never the
  workspace), `runner.ts` (tail-based per-case timeouts, provisional timeouts retried at 2 s,
  load-scaled caps, all-killed batches re-queued once; rungs §8, §12, §15).
  `src/synth/search/subgoal.ts` walks the phases SEEDS → SKETCH → BEAM → WIDENED, runs a
  site's seed sources as one SIEVE batch decided once, and tests pairs of complementary
  partials inside a 15 s / 16-run reserve before a batch would spend it (rungs §15).
- **Issue oracle.** `src/synth/oracle/extract.ts` extracts fenced, REPL, traceback and
  expected-vs-actual blocks from the task text; `questions.ts` asks one Jev batch per instance
  (`is_reproduction_i`, `shows_expected_i`, `shows_actual_i`, Choice `failure_kind`);
  `runner.ts` builds a runnable script with a code-computed pass criterion and runs it under
  `PYTHONHASHSEED=0`; `verify.ts` runs candidates on lanes against the reproduction first and
  the scoped regression suite second; `search.ts` picks the regression scope (≤ 6 related test
  files, native runner command), confirms a reproduction verdict with a second run, and holds
  the best-guess goal. Measured: a valid oracle (fails at the base commit, passes with the
  gold patch) on 9/30 SWE-bench Verified instances for $0.0096
  (`experiments/results/oracle-from-issue.md`).
- **Repository mode.** `src/synth/search/index.ts` (`initRepository`, `rebaselineRepository`):
  when the workspace is a repository with no failing test, the oracle's reproduction becomes the
  goal (`repro::<sha8>`); one localisation anchored on the traceback frames; a regression
  baseline scoped to the related test files; the corpus read is the first 1,200 files with the
  task-named files first (the 400-file alphabetical cut left 5 of 9 gold files unloadable,
  `experiments/results/swebench-reach-oracle-9.md`); when no oracle exists, one best-guess
  regression-only commit per run, its goal text and `openProblems` note reading "no reproduction
  oracle: best-guess fix, unverified" (`proposal.ts BEST_GUESS_NOTE`). The introspection and
  history harvests run once at the establishing step and again on a checkpoint restore;
  `src/synth/search/memory.ts` keeps a per-run file cache so a re-baseline re-analyses only
  changed files and an LRU of four run memories (rungs §20). Native runner detection is in
  `src/workspace/tests.ts` (`tests/runtests.py`, `bin/test`, `unittest discover`) with the
  parsers in `src/synth/verify/runners.ts`.
- **Candidate sources** (design §3). `src/synth/mutate/` (operator families over the site's
  line; `collapse_collection_to_element` at statement-level sites and in WIDENED),
  `src/synth/templates/` (guards, conditions, branches, imports, statements, signatures,
  attribute and callee substitution; added 2026-09-20: `stdlib.ts` stdlib-sibling callee
  substitution that carries its import as an extra edit, `wrap2.ts` depth-2 wraps in WIDENED,
  `introspect.ts` attribute-predicate guard and MRO method alias, inert without introspection
  facts), `src/synth/donor/` (lines elsewhere in the corpus with identifiers re-bound by a Jev
  Choice per hole), `src/synth/search/composite.ts` (pairs of seeds, signature units that thread
  a parameter to every call site, donor-body units; bounded by a 3 s per-unit deadline and a
  5,000-statement call-site cap after one enumeration did not return in 27 min, rungs §16),
  `src/synth/sketch/` + `fill/` + `beam/` (sketch productions ranked by Jev, slot filling, a
  grammar-guided token beam), `src/synth/introspect/` (a pass appended to the reproduction
  script: MRO class names, `is_*` predicates with their truth value at the failing call, module
  names; ≤ 400 names, fed to the vocabulary and the templates), `src/synth/history/` (the
  reverse of each change run in the ≤ 5 most recent commits that touched the located
  identifiers or the ticket the issue names, offered as candidates; ≤ 8 read-only git commands).
  At the gold sites of the nine oracle instances all six reach-study targets are now enumerated
  and pass FAIL_TO_PASS (rungs §16.2, §18.2); the QuixBugs SEEDS sets are unchanged (40/40 gold
  in SEEDS, rungs §16.3).
- **Sites.** `src/synth/localize/` (file, function and line stages; `sites.ts` builds replace
  sites, insert gaps at every statement boundary with legal indents, and statement-level sites
  whose `currentLine` is a multi-line statement joined onto one line, `Site.endLine` the span).
  `src/synth/search/sites.ts` orders a goal's sites from the Jev line anchors (Q5/Q5n), SBFL
  top-5 (`src/synth/sbfl/`), the gap slots around each anchor including the loop-exit gap,
  evidence-ordered WIDENED sites cut at 24, and up to two introspection-derived sites (the
  class-body gap of the class the failing call points at and its module import gap).
- **Guard.** `src/synth/search/guard.ts` decides on a run batch (design §2.6): passers are
  clustered by behaviour on inputs `perturb.ts` derives from the visible tests (JSON cases,
  linked lists from pytest `Node` chains; run on the sieve's lanes); one Q15/Q16 request
  arbitrates between cluster representatives with an escape; a set whose escape ≥ 0.8 and every
  Noul < 0.1 is all-overfit and held. A lone passer is committed at once unless it carries a
  code-computed suspicion signal (`deletes_statement`, `duplicates_block`,
  `guards_other_variable`, `dead_guard`) or its site still has a seed source to run; a held
  passer is arbitrated against later passers and released at the step end or the budget
  reserve, never past the step (rungs §13). `bases.ts` keeps the held and pending passers, the
  improved base and the remembered partials.
- **Progress-aware park rule and oracle-derived run cap** (design §4.3 and §5.3, dated
  paragraphs). `budget.ts repositoryRunsPerStep`: `runs = floor((testWall − 5 × t_run(fullSuite))
  / t_run(goalSubset)) × lanes`, bounded to [16, 160]; in RANK mode the take per site is its
  share of the runs left. `goals.ts noteBudgetHit(goal, progress)`: a budget-hit step that
  tested a site no earlier step had tested is progress and does not count toward the
  two-stagnant-steps park nor toward "3 searches without a commit"; a hard cap of four
  consecutive budget-hit steps parks whatever they tested (`MAX_BUDGET_HIT_STEPS`), so the
  loop detector's `run:` signature trips at most once per goal.

### 21.2 Loop-side rules added for jev-only (all code rules over facts the harness knows; Jev stays the decider)

Each was measured on the ladder before it landed (`experiments/results/jev-only-ladder-4-analysis.md`,
rungs §9, §14, §17). The synthesizer's `Proposal.evidence` reaches the risk and judge states with
rubric clauses that tell a verified fix from "skipping verification" (rungs §9); the intent stage
is ledger-aware in this mode (`src/loop/stages/intent.ts`: an `edit` intent becomes `verify`
while a change is unverified; a `finish` fallback is rescued when the engine's last run is green
and current).

- **Verified completion** (`src/loop/stages/risk.ts completionVerifiedByRun`, `engine.ts
  verifiedCompletion`): a `done` whose `plan.remaining` is empty while `workspace.testsCurrent`
  and `lastTestRun.allPassed` hold is not refused by the risk stage; Jev's answers stay in the
  record and the completion Noul still decides the stop.
- **Verification run** (`risk.ts isVerificationRun`): one plain invocation of the detected test
  command (or a scoped form) with `destructive` and `irreversible` at expected level ≤ 1 never
  lands in the review band on spread alignment mass; the alignment dimensions are recorded, not
  gating. In bench runs a review is a decline, and 9 of round 4's 16 refused runs were this
  standing run with verified evidence.
- **Novel verified patch** (`risk.ts novelVerifiedPatch`, `PatchHistory`,
  `proposal.priorPatches` in the risk state): a change proposal whose evidence is verified with
  no newly-failing tests and whose content differs from every *applied* earlier patch of the run
  is gated by harm alone; the rubric says a different verified patch after one that did not fix
  the goal is a new attempt, not a repeat. Measured on `django__django-15315`: six refusals of
  four distinct verified patches → zero (rungs §17.4).
- **Failing-set signatures** (`src/loop/loopdetect.ts testFailureIdentity`, `failingTestIds`):
  the `fail:` signature of a non-zero test-runner run is the sorted set of failing test ids
  (pytest, unittest/Django, sympy, cargo, go, vitest/jest forms), with `counts:` and the old
  text hash as fallbacks; three runs are the same failure only when the sets are identical.
  Refused proposals are signed by the proposal alone (`run:<sha12(cmd)>:refused`), a trip resets
  only the tripped signature, and a second `gather_context` for the same refused `done:`
  signature is treated as `stop_and_report` (§6 of this document carries the dated paragraph).
- **No-op `done` carries the engine's last run** (`src/loop/state.ts doneExecutedJson`,
  `src/loop/stages/complete.ts`): the judge state of a `done` after a run includes the run's
  parsed counts, `testsCurrent` and a `lastRun` block, and the completion criteria name it;
  ladder `grades`/`shipping`/`table` went from 47 steps (round 5) to 20 and 19 with 0 loop
  replans (rungs §17.3).

### 21.3 Deviations from the original jev-only design, and why

- **Q17 deleted** (design §2.7 row, DECISIONS "Q17 deleted"). The progress Nouls and the
  `closeness` Score were a pure function of the pass counts the harness already computes
  (240/240) and were asked 0 times live; progress is `src/synth/verify/progress.ts` and a tie
  between partials is the code rule `compareTieKeys` (fewer newly-failing tests, smaller diff,
  earlier candidate).
- **Run cap derived from the oracle, not the class** (design §4.3 dated paragraph). The
  repository class's fixed 16 runs per step was sized for a full-suite oracle; with the issue
  oracle the goal-subset run is a 1–3 s reproduction and only the ≤ 5 passers pay the scoped
  suite, so the cap let 16 of 727 candidates run per step on `sympy__sympy-15345` and parked the
  goal with sites 3–12 unvisited. The count is now `repositoryRunsPerStep` (above); the QuixBugs
  class keeps 1,500.
- **Partials survive parks** (rungs §15; design §2.3 said "partials held as a second base" but
  `forgetGoal` on park dropped them). `bases.ts forgetHeld` keeps the remembered partials across
  a park and persists ≤ 4 per goal in `synthState`; pairs are tested before a park and on every
  budget exit; a held passer is committed on a budget exit; `change_approach` reopens every
  parked goal, not the newest. Still open: a *lone* partial is never committed (long tier, rungs
  §19.7); the fix in flight is a progress commit of the best regression-free partial.
- **Statement-level sites** (rungs §16, §20). The design's replace site was one physical line;
  a five-line `return hash((…))` could not be rewritten and 1,143 of 2,171 candidates broke the
  module import. A statement site stands in place of the physical site at the statement's first
  line and applies as one replacement plus deletions of the continuation lines.
- **A lone passer may be held within a step.** Design §2.6 said a lone passer is never withheld
  on a Noul threshold; two run-3 overfits were committed as the first lone passer of a step while
  the gold's site was still ahead. The hold is bounded to the step (rungs §13); the constants
  behind it are disclosed as in-sample in `docs/JEV-ONLY-DESIGN.md` §7.
- **History source built** (design §3 listed it as "not in v1"); **introspection source added**
  (not in the design); **best-guess commit** when no oracle exists (from the SWE-bench decision,
  DECISIONS 2026-09-20); **corpus read raised** from 400 alphabetical files to 1,200 with the
  task-named files first.
- **Repository-mode results so far.** First attempt 0/30 (20 evaluated, every patch empty,
  `bench/results/jev-only-swebench-1`); `sympy__sympy-19954` is the first SWE-bench instance
  solved with no generating model (8 steps, $0.024, `bench/results/jev-only-swebench-2-oracle`);
  the full-30 run on the wired tree is in progress (`bench/results/jev-only-swebench-3`).

## 22. LLM+Jev mode (`llm-jev`, 2026-09-21)

`EngineMode` gained `'llm-jev'` (`src/core/types.ts`). The mode is the jev-only synthesizer of §21
(Ledger + Sieve: code proposes candidates, tests verify them in shadow lanes, Jev chooses among
concrete options) with the generating LLM — `z-ai/glm-5.3-flash` through OpenRouter — wired in as
**one more candidate source** rather than as the step-proposer of `jev-on`. The engine still runs
one `Proposal` per step through risk, execute, judge and commit; inside the propose stage the
synthesizer asks the LLM for `{path, old, new}` hunks, anchors and compile-checks them, runs them in
lanes beside the code seeds, and lets the guard commit what passes. Design: `docs/LLM-JEV-DESIGN.md`
(rev 2 plus the §4.13 live addendum); the measured reasons for it: `experiments/designs/llm-jev-map.md`.
This section describes what is in the tree at `626fc40` (2026-09-21) — file names are the ones to
open, not the design's anchors — and lists where the tree departs from the design and why.

> **Every environment switch that changes what a run does is tabulated once, in `docs/LLM-JEV.md` §5a**
> ("Harness environment switches": name / accepted values / default / effect / reading file, for `JEVCODE_JEV`,
> `JEVCODE_ROUTERS`, `JEVCODE_FASTPATH`, `JEVCODE_WARM`, `JEVCODE_HEDGE`, `JEVCODE_DEADLINE_GROWTH`,
> `JEVCODE_CASE_TIMEOUT_MS`, `JEVCODE_MAX_CASE_TIMEOUTS` and `JEVCODE_BENCH_CONTEXT`). Nothing in this section or
> in §22.3–§22.8 restates a default that table owns. Settings-shaped variables (`JEVCODE_MODE`, `JEVCODE_MODEL`, …)
> belong to `src/config/defaults.ts`'s settings table instead.

What landed when (`git log 2a92d0b..HEAD`, all 2026-09-21): the map (`214bf55`) and the design
(`22e5153`); stage 1 — the sanctioned generator channel, mode plumbing and code-fact stages
(`a0f7fbc`, fixes `64c8d3e`); stage 2 — GLM details on the OpenRouter provider (`61c15b6`, fixes
`87b0be1`); stage 3 — the LLM source under `src/synth/llm/` (`2651024`, fixes `24fc2d7`); the
integration commit that made `src/core/types.ts` the single contract source (`652e5bf`) and the
§4.13 addendum (`ca0335f`); stage 4 — the source wired into the search (`c8f0939`, fixes `67208b5`);
stage 5 — bench arms and measurement (`304be21`, fixes `9376b75`); the merge into `main` after the
TUI round-2 commits (`d09e24c`) and the session wiring of the synthesizer with its pinned
generation and pricing table (`626fc40`). The jev-off GLM baseline the mode is measured against was
committed in between (`82cdf68`, `experiments/results/glm-jev-off-baseline.md`,
`bench/results/glm-jev-off-{quixbugs,ladder,swebench}`).

### 22.1 Purpose and the dominance requirement

The mode exists to solve Python repair tasks (a failing test, an issue with a reproducible
failure, a QuixBugs-class one-line bug, a ladder-class multi-hunk bug) with GLM-5.3-flash as the
only generating model and `typesafe/jev-1.13-20260917` as the only decider, and to be **heavily
better and faster than the same GLM run generator-only** (`jev-off`, `src/loop/generator-only.ts`,
which must not move) on three quantities at once: pass rate (plus correct-by-verdict), wall time
per task and dollars per task. The requirement is pre-registered in `docs/LLM-JEV-DESIGN.md` §1.3
(discordant-pair sign tests on pass, one-sided Wilcoxon on paired wall, cost ratios per solved
task, and a secondary attribution criterion against a no-Jev arm); §1.1 states the goal and §2
the principles the code follows (Jev decides only what it is measured to decide well; the LLM
writes code and explains; tests arbitrate; code computes counts and completion; nothing waits for
the slowest thing; every accounting is complete).

Why the old loop was replaced rather than tuned — the map's measurements, restated in the design's
§13: the intent Choice fell back 46 % of the time; the context Nouls were 71 % of jev-on's Jev cost
at a 0.5 cut; the alignment risk Scores (`out_of_scope`, `plan_mismatch`, `matches_intent`) were
100 % of the 223 bench refusals (≈ 12.6 non-executing steps per 24-step run); `task_complete ≥ 0.85`
fired on 2 of 42 live answers; the generator re-emitted its plan on every call (≈ 15 s per GLM call
at the measured 14.7 ms per output token) and 13–35 % of single samples were malformed.

The numbers are measured, not assumed: the paired head-to-head of design §10 is produced by
`experiments/llm-jev/headtohead.mts` over the bench results dirs (statistics in
`src/bench/headtohead.ts` and `src/bench/stats.ts`), and its report is
`experiments/results/llm-jev-headtohead.md`, being produced as this section is written; see
`docs/LLM-JEV.md` for the numbers. The baseline table of design §1.2 is regenerated by the same
estimator (`experiments/llm-jev/baseline-table.mts`). The pre-bench probes of design §10.2 are in
`experiments/results/llm-jev-probes.md` (and `llm-jev-probes-off.md` for the refused
`reasoning: {enabled: false}` variant).

### 22.2 The step pipeline as built

One engine step in `llm-jev`. Stages 0, 5–8 are the engine's; stage 4 is one
`Synthesizer.synthesize(ctx)` call that spends Jev requests, GLM samples and lane runs and returns
exactly one `Proposal`. The order in `src/loop/engine.ts runStep` is: budgets → replan (only on a
loop-detector trip) → propose → code intent → risk → confirm → execute → judge → commit; no
intent or context request is made.

| Stage | Who decides | Inputs | File |
|---|---|---|---|
| 0 Budgets, pause pane, steers, `git status` | code (spend_cap → token_cap → wall_time → max_steps → max_replans) | meter, clock, counters | `src/loop/engine.ts` (`runStep`, `checkBudgets`) |
| 1 Replan, only when `detector.tripped()` | Jev Q19 (`next_move` Choice + paired Nouls + `task_impossible`) | common state + loop signature | `src/loop/stages/replan.ts` |
| 2 Intent | **not asked**: `codeIntent(kind)` after the proposal (`patch` → `edit`, `run` → `verify`, `done` → `finish`, `read` → `investigate`); the `intent` event follows `proposal` with `verdict: 'code'` | the proposal's action kind | `src/loop/engine.ts codeIntent` |
| 3 Context | **not asked**: the synthesizer loads every non-test `.py` itself | — | `src/synth/search/index.ts` (`deps.loadFiles`) |
| 4 Propose = `synthesize()` | the synthesizer; the engine only measures `synthMs` and flushes the per-sample generator rows | `SynthesisContext` (`ask`, `generate`, `sandbox`, `workspace`, `synthState`) | `src/loop/stages/synth.ts`, `src/synth/index.ts createSynthesizer`, `src/synth/search/index.ts LedgerSieveSynthesizer` |
| 4a Ledger / rebaseline | code; a green lane run is adopted as the baseline when the loaded tree equals the lane's post-image (`adoptableLaneRun`); the establishing run of jev-only is not proposed | committed workspace, last commit's lane outcome | `src/synth/search/index.ts rebaseline`, `rebaselineRepository`, `engineNeedsRun` |
| 4b Pick goal | code; Jev Q1 `attack_first` only with ≥ 2 open goals | ≤ 10 goals keyed by first test id | `src/synth/search/goals.ts pickGoalDetailed` |
| 4c Oracle (repository class, once per run) | code extracts and runs the issue's snippets; when none is valid and `ctx.generate` exists, the L2 writer asks GLM for scripts, code filters them, Jev Q18 picks | issue text, package, framework | `src/synth/oracle/search.ts findIssueOracle`, `src/synth/search/index.ts writeReproductionL2`, `src/synth/llm/repro.ts` |
| 4d Localise | Jev Q2–Q6 (files, functions, lines, gaps) plus code: the traceback frames' functions are always listing members; the Q6 fallback is batched into one request per state (`batchQ6Fallback`) | task, `FailureView`s, traceback, files | `src/synth/index.ts locate`, `src/synth/localize/*`, `src/synth/search/sites.ts` |
| 4e Seeds → lanes | code SIEVE when `t_run ≤ 2 s`; Q8–Q10 (full-criteria Nouls in chunks ≤ 50 for 11–150 candidates, `fullCriteriaNouls`) in RANK; at repository sites `mutation` is marked exhausted instead of ranked | sites, base files | `src/synth/search/subgoal.ts visitSeedBatch`, `src/synth/rank/index.ts` |
| 4f LLM round L1 | the LLM: N `propose_fix` samples, staggered on QuixBugs/ladder class (sample 0 with the seeds, 1..N−1 released when the top-site batch has no passer), whole on repository class (fired before the scoped baseline at step 1) | listings ∪ failure evidence ∪ attempt ledger | `src/synth/search/llm.ts createSearchLlm.fire`, `src/synth/llm/source.ts createLlmSource`, `src/synth/search/subgoal.ts startLlm`, `src/synth/search/index.ts fireEarlyRound` |
| 4g Order | code runs every distinct sample when it can; Jev Q17 orders them only when `distinct > runsLeft` or `t_run > 2 s` (RANK) | ≤ 8 distinct samples as hunk views | `src/synth/llm/rank.ts`, `src/synth/search/subgoal.ts runLlmRound` |
| 4h Verify | lanes (8/4/2 by measured `t_run`); the queue is awaitable so lanes start on the first parsed sample; a batch begun while the queue streams ends on its first plausible outcome (`runQueue` and `runRepositoryQueue` alike), so the controller decides at once, cancels the round's losers as `commit` and re-enters the stream when the guard holds; workers parked in `next()` are released (`VerifyQueue.next(signal)`, `runner.ts awaitNextJob`) when dispatch stops, the step signal fires or the wall no longer fits one run; ≤ 5 full-suite runs per step | queue in key order | `src/synth/sieve/queue.ts` (`open`/`next(signal)`/`close`), `src/synth/sieve/runner.ts runQueue`, `awaitNextJob`, `src/synth/oracle/verify.ts runRepositoryQueue` |
| 4i Guard | code: 0 plausible → hold partial; one behaviour cluster holding a seed and an LLM passer → the LLM member (`preferLlmInCluster`, no Jev); ≥ 2 clusters → Q15/Q16; the seed-vs-LLM grace waits ≤ min(6 s, deadline left) for sample 0 | `VerifyOutcome[]` of seeds ∪ arrived LLM candidates | `src/synth/search/guard.ts decide`, `src/synth/search/subgoal.ts afterSeedBatch` |
| 4j Proposal | code | committed candidate → unified diff (≤ 4 files for an `llm` winner), `ProposalEvidence{selection: 'llm'…}`; the claiming `run` carries `evidence.completion`; the revert route emits `revert_last_change` | `src/synth/search/proposal.ts proposePatch`, `completionEvidence`, `proposeRevert` |
| 5 Risk | code `ok` before any Jev request for a verified patch, a verification run, a verified `done`, a recoverable revert, a `read`; otherwise Jev Q20 harm-only (`destructive`, `irreversible`) | proposal, targets, evidence | `src/loop/stages/risk.ts runHarmOnlyRiskStage`, `codeRiskReason` |
| 6 Confirm + execute | human in the review band (bench: decline); `git apply` / the test command | proposal | `src/loop/stages/execute.ts` |
| 7 Judge | code on every step (`codeJudge` on a `run`; `null` on patch/read); Q21 `done_<j>` / `tests_pass_unparsed` / Q22 `task_complete` asked in one request and recorded only | parsed counts, `evidence.newlyPassing` | `src/loop/stages/judge.ts runCodeJudgeStage` |
| 8 Commit + completion fact | code: `isCompleteByFact()` stops the run `complete` on the claiming `run` step itself (or on a `done` the engine's own green, current run verifies) | draft + `evidence.completion` | `src/loop/stages/complete.ts`, `src/loop/engine.ts completeAfter`, `completionFact` |

Timing: `StepTiming.synthMs` is the wall of `synthesize()`; `generatorMs` is the wall of the
sample batch (the union of the samples' intervals, `noteSampleStart/End`), never the sum;
`harnessMs = total − synthMs − execMs − confirmMs − shellJevMs` (`engine.ts stepTiming`). New
`synth` event phases: `llm:fire`, `llm:sample`, `llm:cancel`, `llm:round`, `llm:release`,
`llm:phase`, `llm:rank`, `llm:feedback`, `llm:error`, `grace`, `revert`, `rollback`, `baseline`,
`oracle`; `generator:*` events carry `sample`. The TUI streams sample 0 into the live region and
shows `k/N` for the rest (`src/tui/useEngine.tsx`); `/mode llm-jev` and `--mode llm-jev` exist
(`src/tui/commands/registry.ts ENGINE_MODES`, `src/cli/args.ts MODES`, `src/config/validate.ts`).

### 22.3 The LLM candidate source (`src/synth/llm/`)

`src/synth/llm/index.ts` re-exports six modules. The engine never calls the provider for this mode
itself: `SynthesisContext.generate(req, {sample, purpose, signal})` (`src/core/types.ts
SampleOptions`) is the one sanctioned channel, bound in `engine.ts synthesisContext()` to the
engine's `generate()`, which meters, records and emits per sample (§22.6).

- **Prompt** (`prompt.ts`). `buildFixSystemPrompt()` is one fixed text per run (the harness has
  localised the fault, runs every patch in an isolated copy, commits only what passes; return 1–3
  genuinely different patches; `old` verbatim from the listing, unique in the file; empty `new`
  deletes; never edit `tests/`; ≤ 4 files and 12 edits; fill `need` when the fix needs unseen
  code). `buildFixUserMessage()` writes bounded sections — `# Goal`, `## Task` (head 3,000 + tail
  1,000 chars), `## Failing behaviour` (≤ 3 `FailureView`s: call ≤ 200, expected/actual ≤ 300,
  status; traceback tail ≤ 1,500; on repositories the reproduction script ≤ 60 lines and its base
  output ≤ 600), `## Localisation` (traceback frames first, then ≤ 5 Jev-ranked lines),
  `## Code` (≤ 4 listings × ≤ 120 `L<n>: text` lines), `## Other files` (repository: ≤ 5 outlines ×
  ≤ 40 symbols), `## Earlier attempts this run` (≤ 6 rows × ≤ 600 chars: verdict then diff head),
  `## Best partial so far` (≤ 1,200 chars), `## Hint`, `## Reply` — every cap in
  `PROMPT_LIMITS_FIX`. The listing set (`listingSet`) is code ∪ jev: the ≤ 3 deepest workspace
  traceback frames' enclosing functions (never removed by Jev's rank) then the Jev anchors in rank
  order, de-duplicated by span; a module-level member is a ±40-line window. Hints per sample:
  h0 none (sample 0), h1 "Jev put p=0.xx on `path:L<n>`" **only when Q5's P(top) ≥ 0.9**
  (`H1_MIN_TOP_P`; `renderHint` drops an ungated h1 silently), h2 smallest change, h3 a statement
  may be missing, h4 the Q7 edit class (QuixBugs class only, when Q7 was asked); the repository
  fast-reproduction column adds h1+h2 (`hintSchedule`). No plan, no intent, no window of prior
  steps.
- **Structured output** (`schema.ts`). Forced tool `propose_fix`, flat strict JSON schema (no
  `oneOf`): `{analysis ≤ 300, patches[0..3]{rationale ≤ 200, edits[1..12]{path, old, new,
  near_line}}, need{paths ≤ 3, symbols ≤ 6}}` (`FIX_LIMITS`); `write_reproduction` for L2:
  `{script ≤ 60 lines, expected_behaviour ≤ 300, issue_quote ≤ 200, failure_kind}`
  (`REPRO_LIMITS`). `parseProposeFix` / `parseWriteReproduction` read the forced tool call, else
  the last fenced JSON block (`provider/actions.ts extractLastFencedJson`); anything else is
  `malformed` and dropped, never retried. `isLengthStop` reads `length` / `max_tokens`.
- **Rounds: N, stagger, temperatures, seeds, deadlines** (`source.ts`, sized in
  `search/budget.ts`). `SAMPLES_PER_ROUND = {quixbugs: 4, ladder: 3, repository: 6}`,
  `SAMPLES_REPOSITORY_SLOW = 4` when the reproduction takes > 2 s; the class is
  `llmClassOf(oracle, goals, repository)` — repository mode or a repository-class oracle →
  `repository`, ≥ 2 ledger goals on the cheap class → `ladder`, else `quixbugs`. `staggered(klass)`
  is true off the repository class: `fire()` starts sample 0 and `release()` starts 1..N−1
  (`subgoal.ts releaseLlm` calls it when the top-site seed batch returns without a passer, or at
  once when the top site has no seeds). Temperatures `{first: 0, rest: 0.8, feedbackFirst: 0.6,
  feedbackRest: 1.0}`; `seed = step × 100 + k` for k > 0; `providerPrefs: {requireParameters:
  true}` on every sample. Deadline `sampleDeadlineMs` (**as built 2026-09-21**, after the v2
  head-to-head cut 31 of 100 samples at a fixed deadline — llm-jev-headtohead-v2.md §9 class C′):
  `clamp(LLM_DEADLINE_ADAPT.factor 2 × the running p90 of SERVED samples this run, the class
  default, the class ceiling)`, i.e. the
  deadline only ever **rises** from the class default (`LLM_SAMPLE_DEADLINE.maxMs` 20 s on the cheap
  classes, `.repositoryMs` 30 s on repositories) up to `cheapMaxMs` 45 s / `repositoryMaxMs` 90 s.
  The p90 is used once `LLM_DEADLINE_ADAPT.minSamples` 2 samples have been served; before that the
  §10.2 probe's p90 stands in (clamped the same way), and with neither the class default is used.
  Served = the provider returned a result: a timeout, a cancellation and a 429 served nothing, so
  the sample cut by the deadline cannot pull the deadline down (the served latencies are
  right-censored by the deadline itself, which is why the rule takes 2 × p90 and not the superseded
  2 × p50). It is per run and in memory — nothing is persisted; the round records what it fired with
  (`LlmRoundSummary.deadlineMs`) and the `llm:fire` line says whether it was adapted and from what.
  When `providerSlow` (the served p90 is past the class default, i.e. the deadline has already been
  lifted and the samples still do not land inside it) the run caps every further sample's
  `reasoning: {maxTokens}` at `LLM_REASONING_CAP_TOKENS` 512 — one-way, never un-capped, so rounds
  stay comparable — and emits `llm:deadline`; GLM bills reasoning, so the cap shortens both the wait
  and the bill. `LLM_REPLAY_DEADLINE_MS` 10 s bounds a cache replay.
  `max_tokens` base 3,000 with `reasoning: {effort: 'low'}` (1,500 when reasoning is off or
  unsent), doubled once for a goal after a `length` stop (`maxTokensFor`, `lengthGoals`). Each
  sample is `generateWithDeadline`: its own `AbortController` linked to the step signal
  (`provider/sse.ts linkedAbort`), a timer that aborts with `LlmSampleTimeout`, and an outcome
  that never rejects (`SampleEnd`: result | timeout | cancelled | error). `cancel(reason)` aborts
  every in-flight sample with `LlmSampleCancelled('commit' | 'budget' | 'abort')` and resolves
  when the round has closed. A round always closes: every chain ends in `settle()`, whose queue
  push, pending count and `maybeClose` run in `finally`.
- **Sample → candidate** (`candidates.ts`). `convertSample` validates (workspace-relative path,
  not `TEST_PATH_RE`, present in the base files, ≤ 4 files, ≤ 12 edits, non-empty `old`,
  non-overlapping hunks), anchors every `old` to a unique span in three tiers — exact →
  whitespace-normalised → code-token signature (`rank/questions.ts lineSignature`) — with
  `near_line` settling several matches only inside ±20 lines (`NEAR_LINE_WINDOW`) and only when one
  is strictly nearest; else the hunk is `misanchored` (fed back to the ledger). The primary hunk
  (highest-ranked listing member; a deletion only when every hunk deletes) becomes a block-anchored
  `Site` with `span: {endLine, textSha}` (`llmSiteAt`), the rest `extraEdits` in before-edit
  numbering (`hunkEdits`: replace the first line + delete the continuation, or delete every line).
  `applyLlmCandidate` dry-runs the edit bottom-up per file exactly as `verify/apply.ts`
  `applyCandidate` does (which validates a `Site.span` by `spanTextSha`, never by the one-statement
  token check, and treats `text === ''` as deleting every span line). Then the compile check:
  `createAstCompileCheck` writes each post-image to `<runDir>/tmp/synth/compile/<sha12>.py` and runs
  `python3 -c "import ast,sys; ast.parse(...)"` through `ctx.sandbox.run` (10 s timeout, verdicts
  cached by content hash, temp files removed at step end by `SubGoalLlm.stepEnd`); a
  `SyntaxError` drops the patch as `syntax_error`, a rejecting checker as `compile_failed`.
  Dedupe by `sha12(diff)` (`memory.ts diffHash`) against `mem.tried` (→ `tried`, with the earlier
  verdict) and the round's `seen` map (→ `duplicate`, bumping the first candidate's `prior` = the
  agreement count); the sha is reserved before the awaited compile check so concurrent twins fold.
  Candidate shape: `{id: 'llm:<sha12>', source: 'llm', op: 'sample_<k>_<j>', prior, provenance:
  rationale, site, text, extraEdits}`. `reanchorLlmSite` re-anchors an `llm` site on an improved
  base by text (`subgoal.ts siteOnBase` uses it). The vocabulary pre-check is bypassed for `llm`
  (`sieve/queue.ts`).
- **Attempt ledger** (`candidates.ts`, `search/llm.ts`). Every classified run of any source
  becomes an `AttemptRecord` (`attemptFromOutcome`: `plausible` / `regressed: N newly failing
  (<test>: E <first line>)` / `partial: fixed …; <test> still fails, actual …` / `unchanged` /
  `unstable` / `timeout` / `apply failed`); dropped hunks add rows for `syntax_error`,
  `misanchored` and `tried` (`attemptFromDrop`). `recordAttempts` keeps ≤ 60 rows per goal in
  `mem.llm.attempts`; `attemptLedger` shows the latest 6, one per diff; `attemptsHash` is part of
  the round cache key so the same context with new verdicts is a new round.
- **Cache and accounting** (`source.ts`). Rounds are cached in memory by `llmCacheKey(goalId,
  listingHash, attemptsHash, round)`; a re-fire with the same key replays the cached patches
  (re-anchored and compile-checked against the current base, arriving as sample `−1`, status
  `cached`) and skips generation when ≥ N distinct untried candidates are known.
  `exportCache()` is the ≤ 4 KB `{goalId: {round, sha12[]}}` persisted under `synthState.llm`
  (sample bodies are not persisted; a resumed step re-asks). Every sample is charged to the
  step's `LlmBudget` (`budgetView` over `StepBudget.llmRoundsLeft / llmSamplesLeft / llmUsdLeft`,
  read lazily so a re-baseline mid-step keeps the counters honest): a priced result at
  `usage.costUsd`, else tokens × the served rate `LLM_SERVED_PRICING` $0.15/$0.50 per M; a
  timed-out, cancelled or failed sample at the **estimated full cost** (sibling `prompt_tokens`
  else prompt chars / 4, plus `max_tokens` output). `LlmRoundSummary` counts fired / valid / empty /
  malformed / length / timeouts / cancelled / errors / misanchored / syntaxErrors / compileFailed /
  duplicates / tried / distinct / needs / wallMs / usd / estimatedUsd and reaches
  `GoalSearchTrace.llm` (`subgoal.ts settleLlm`) and the proposal's `rawText`.
- **L2, the reproduction writer** (`repro.ts`; repository class, once per run, only when the code
  oracle found nothing and `ctx.generate` exists — `search/index.ts writeReproductionL2` runs it
  before the best-guess path). N = 3 `write_reproduction` samples at temperatures 0 / 0.7 / 0.7
  with a 20 s deadline, the pinned `reasoning` and `max_tokens` base (never doubled), charged to
  `llmUsdLeft` and booked into the run total through `SubGoalLlm.recordSpend`. Code then refuses,
  before any Jev request: a script over 60 lines, calling `sys.exit`/`exit`/`quit`, reading stdin
  or spawning a process (`scriptProblems`); an `issue_quote` that is not a verbatim ≥ 6-consecutive-
  token substring of the issue (`issueQuoteAnchored`); a duplicate script; a script that did not
  run, passes at base, stops on a NameError/ImportError-class exception (`snippetIncomplete`),
  needs the network (`detectNetworkUse`), or passes on the second base run (`unstable`) — every
  script runs under the sentinel harness (`oracle/runner.ts runRepro`) with criterion
  `{form: 'no_exception'}`. The survivors go to Q18 (§22.4); the pick becomes a `ReproGoal` with
  outcome `llm_valid` (Noul ≥ 0.7) or `llm_weak` (0.3 ≤ p < 0.7) and the note
  `LLM_ORACLE_OPEN_PROBLEM` ("llm-written reproduction") on every proposal; an `llm_*` oracle
  **never completes a run** (`COMPLETING_ORACLE_OUTCOMES` excludes it).
- **The search adapter** (`src/synth/search/llm.ts`, injected as `SubGoalDeps.llm`). One
  `LlmSource` per run (`runOf`), its compile check rebound to each step's sandbox (`bindCompile`);
  `fire(ctx, mem, goal, loc, {round, widen, needPaths, editClass})` assembles the prompt from
  what the search holds (committed base files, `LocalizeResult` sites and beam, traceback or
  baseline tail, reproduction, held partial, ledger), sizes N with `decideLlmN`, and wraps the
  fired round as a `PumpedRound` (`LlmRound`: `release`, `ready`, `next`, `rest`,
  `waitFirst(ms)`, `cancel`, `deadlineLeftMs`, `summary`) whose arrivals are pumped into a buffer
  the loop reads at its own pace; `order()` is Q17; `spentUsd` / `recordSpend` feed the step cap
  `min($0.02, (spendCap − spent) / stepsLeft)` (`budget.ts llmStepUsd`, `LLM_ROUNDS_PER_STEP` 2,
  `llmSamplesLeft = N × 2`).

### 22.4 The Jev questions actually asked in this mode

All questions are built with `choice()` / `noul()` / `contextNoul()` / `score()` from
`src/jev/questions.ts`, which enforce the REPORT rules at build time (both-sided `definition` +
≥ 2 `examples` per side on every Noul, an escape option — default `none_of_these` — on every
Choice) and are checked per request by `assertQuestionBatch`; they reach the decider only through
`ctx.ask`, so every request lands in `decisions.jsonl`, `jev.jsonl`, the meter and the pane. The
bench pins `typesafe/jev-1.13-20260917` and refuses aliases (`src/bench/cli.ts`).

| Id | Type | Where built | Consumer (code) | Notes |
|---|---|---|---|---|
| Q1 `attack_first` | Choice ≤ 10 goals + escape | `src/synth/search/goals.ts pickGoalDetailed` (existing) | argmax iff it beats the runner-up by > 0.02, else code order; skipped with one open goal | unchanged |
| Q2 `fix_file_<path>` / Q3 confirm / Q4 `fix_function` / Q5 `buggy_line` + Q5n `line_<k>` / Q6 `insert_after` | contextNouls ≤ 250 per chunk; Nouls; Choice; Choice + Nouls; Choice over gaps | `src/synth/localize/*`, `src/synth/search/sites.ts` (existing) | rank cuts (file beam top-5, sites by P(file) × P(fn), anchors = top-3 with p ≥ 0.05 ∪ Noul top-3); Q5's P(top) also gates hint h1 (§22.3) | llm-jev: the Q6 fallback asks about every statement template in one request over one state (`batchQ6Fallback`, `q6FallbackSites`) |
| Q7 `edit_class` | Choice, 6 classes + escape | `src/synth/search/subgoal.ts askEditClassPrior` (existing) | soft source/site order; hint h4 | asked only when `t_run > 2 s`, as before |
| Q8 `fix` / Q9 `is_fix_<xx>` / Q10 shortlist | Choice ≤ 10; Nouls; Choice | `src/synth/rank/index.ts` (existing) | queue order in RANK mode; strong/weak fix-absent as routing after the runs | llm-jev: 11–150 candidates get **full-criteria Nouls in chunks ≤ 50** instead of the compact hybrid (`RankerOptions.fullCriteriaNouls`, `FULL_NOUL_CHUNK`); jev-only keeps the measured compact form |
| Q15 `genuine_fix` + Q16 `general_<xx>` | Choice ≤ 20 cluster representatives + one Noul each, one request | `src/synth/search/guard.ts arbitrate` (existing) | pick = Choice argmax, overridden only when its Noul < 0.3 and another ≥ 0.7; suspect iff P(escape) ≥ 0.5 ∧ max Noul < 0.1 (advisory) | llm-jev: asked only across ≥ 2 behaviour clusters; a single cluster holding a seed and an LLM passer is decided by code (`preferLlmInCluster`); Choice ties put `llm` before the smaller edit (`llmFirst`) |
| **Q17** `fix` + `is_fix_patch_<sha4>` | Choice ≤ 8 distinct samples + escape; one full-criteria Noul per sample (`PATCH_FIX_CRITERIA`), Nouls in chunks ≤ 50 (the first chunk shares the Choice's request) | **new**, `src/synth/llm/rank.ts buildQ17` / `readQ17` / `orderByQ17` | **order only, never a gate**: asked only when `q17Needed` (`distinct > runsLeft` or `t_run > 2,000 ms`) in RANK mode; the Choice ranks the first 8, Nouls break ties and order the rest; the fix-absent signals (strong: P(escape) − p_max ≥ 0.10 ∧ max Noul < 0.3; weak: exactly one) are **recorded** (`trace.llm.fixAbsent`) and only widen the feedback round's listing | keys `patch_<sha4>` carry no position (order-only keys collapse, REPORT §10); state = task ≤ 2,000, listings of the touched functions (≤ 6 × 120 lines), ≤ 3 tests with `actual_with_bug`, candidates as `{file, L<a>-L<b>, replaces, with}` (≤ 3 hunks × 400 chars), the criteria object |
| **Q18** `reproduction` + `reproduces_issue_script_<k>` + `failure_kind` | Choice over ≤ 3 scripts + escape; one Noul per script with the existing `REPRODUCTION_CRITERIA`; 6-way `failure_kind` Choice | **new**, `src/synth/llm/repro.ts q18Questions` / `readQ18` | pick = argmax iff it beats the runner-up by > 0.05, else the fewest lines among the near-ties; escape above the top → no oracle; pick's Noul ≥ 0.7 → `llm_valid`, ≥ 0.3 → `llm_weak`, below → none (best-guess path) | only scripts code proved fail at base twice with a verbatim issue quote reach it; state = `{issue: {repository, problem_statement ≤ 8k}, criteria, scripts: {source, issue_quote, base_run}}` |
| Q19 replan | Choice + paired Nouls + `task_impossible` | `src/loop/stages/replan.ts` (existing) | as before; `task_impossible ≥ 0.85` → stop | only on a loop-detector trip |
| **Q20** harm Scores `destructive`, `irreversible` | 2 Scores × 5 levels (`RISK_LEVEL_TEXTS`) | `src/loop/stages/risk.ts harmOnlyQuestions` | `r = max(E[k]/4, P(k ≥ 3))`; block ≥ 0.7, review 0.3–0.7 (unchanged `src/jev/confidence.ts`); asked **only** when `codeRiskReason` is null — a non-test `run`, an unverified best-guess patch, a partial `done` | the alignment dimensions are recorded at level 0 with `harmOnly: true` in the reason; `matches_intent` / `evidence_consistent` are never asked |
| Q21 `done_<j>` (+ `tests_pass_unparsed`) and Q22 `task_complete` | Nouls, one request on a `run` step; Q22 alone on a `done` | `src/loop/stages/judge.ts buildRecordOnlyQuestions` | **recorded only**: the claim is accepted by `codeJudge` (the suite passed, or the claim's goal tests ⊆ the confirmed `newlyPassing`); a disagreement is a transcript line; `tests_pass_unparsed ≥ 0.85` is consumed only when the parser read nothing (`TESTS_PASS_UNPARSED_THRESHOLD`) | the stop is `isCompleteByFact`, not `task_complete` |

Not asked in this mode (design §5, §13; verified in `src/loop/engine.ts runStep`,
`runHarmOnlyRiskStage`, `runCodeJudgeStage`): the intent Choice and its paired Nouls,
`plan_still_valid`, the context `show:<path>` Nouls, the risk Scores `out_of_scope` and
`plan_mismatch`, the Nouls `matches_intent` and `evidence_consistent`, the judge Nouls
`succeeded` / `error_present` / `new_information`. Q11–Q14 (SKETCH/BEAM) run only once the step's
LLM rounds are spent (`subgoal.ts llmRoundsAvailable`). Compliance in one line: every request is
batched per stage and state, every Choice has an escape, every Noul is both-sided with examples,
Jev is never asked to count, compute, judge a plan, or decide whether an LLM candidate is tested,
and no consumed decision sits at 0.5 — the Q17/Q18 cuts (0.10 margin, 0.3, 0.7, 0.05 tie) are
the ones the probes held or routing margins.

### 22.5 Verification, commit, completion

- **Sieve.** Every candidate is a `VerifyJob` in the `VerifyQueue` (`src/synth/sieve/queue.ts`):
  dedupe by id and canonical text, `unchanged`, `apply_failed`, `tried`; the vocabulary pre-check
  is skipped for `source === 'llm'`. SIEVE jobs are keyed by `sourcePriorAt(position)`; LLM jobs
  take `sourcePriorAt(3) − i·ε` on the QuixBugs/ladder class (after the three seed sources) and
  `1.0 − i·ε` on the repository class (before every seed) — `subgoal.ts llmJobs`;
  `SOURCE_ORDER_PRIOR.llm = 0.35` serves only the `jobFor` default path. The queue is awaitable
  (`open()` / `next(signal)` / `close()`): `runQueue`'s worker awaits `next()` while a round streams
  (`runLlmStreaming`, cheap oracles), so lanes start on the first parsed sample;
  `runRepositoryQueue` does the same. A batch begun while the queue streams ends on its first
  plausible outcome in both runners (`JobQueue.streaming`, `passerStop`: the runs already on a
  lane complete, the jobs still queued wait for the next call), so the controller decides at once
  over what landed, cancels the round's losers as `commit` when the guard commits, and re-enters
  the stream when it holds (`runLlmStreaming`); a worker parked in `next()` is released without
  closing the stream (`VerifyQueue.next(signal)`, `runner.ts awaitNextJob`) when dispatch stops
  (a decisive passer, the passer cap, the run count, a lane failure), the step signal fires or the
  wall no longer fits one run — no worker waits out a round's slowest sample or its deadline.
  The full-suite passer cap is per step
  (`RunnerMemory.passersThisStep`, `MAX_FULL_SUITE_RUNS_PER_STEP` 5, DECISIONS 2026-09-21).
  Lanes are unchanged (`src/synth/sieve/lanes.ts`: `candidate_file`, `git worktree`, `cp -R`,
  `inplace`).
- **The race and the grace** (`subgoal.ts afterSeedBatch`). Once, at the top site: a seed batch
  with no passer releases the staggered samples. At any site while the round is open: a seed
  passer with no LLM arrival yet waits `min(LLM_GRACE_MS = 6,000, deadlineLeftMs())` for the first
  arrival (`PumpedRound.waitFirst`), runs the fresh LLM candidates on a queue of their own
  (`deps.createQueue`, so seed leftovers cannot take the dispatches), and hands seeds ∪ LLM
  outcomes to the one `decide` of the batch; `graceMs` is summed into the trace. When the seeds win
  the round is cancelled with reason `commit` at `settleLlm`; when the goal search ends otherwise
  the reason is `budget`.
- **The LLM phase** (`subgoal.ts visitLlm`, phase `'LLM'` between SEEDS and SKETCH in
  `search/types.ts PHASES`; on repository class `subgoal.ts phaseLadder` places it first —
  `['LLM', 'SEEDS', 'SKETCH', 'BEAM', 'WIDENED']` — so the round fired after `locate` is consumed
  before a single seed is enumerated; QuixBugs/ladder and jev-only keep `PHASES`). SIEVE (`t_run ≤ 2 s`): the round's arrivals stream into the shared
  queue as they land. RANK: `collectForRank` waits for N−1 arrivals, the deadline or the close,
  `decideRunPlan` sizes K, Q17 orders when `q17Needed`, the top K run. Then the feedback round L1′
  (`round: 2`) when round 1 ran and found no passer: the ledger carries every verdict, `## Code`
  widens by `LLM_FEEDBACK_WIDEN` 3 members (6 on a strong fix-absent signal) or the samples'
  `need` paths (`needPathsOf`, ≤ 3), temperatures 0.6 / 1.0, fired whole; at most
  `LLM_FEEDBACK_ROUNDS_PER_GOAL` 2 per goal per run and `LLM_ROUNDS_PER_STEP` 2 per step. L1′,
  SKETCH and BEAM are gated on a round still being able to fire (`llmRoundsAvailable` →
  `budget.ts llmRoundAffordable`): rounds and samples left, and the step's dollar counter less
  what the open round's in-flight samples hold (`LlmRoundSummary.reservedUsd`, `llmHoldOf`) still
  covering one sample — the source holds each fired sample's full estimate until it settles and
  charges the counter the price at settle alone, so the counter as it reads would count a round
  in flight as headroom for a round the source refuses. `decideLlmN` takes the same hold.
- **Guard** (`src/synth/search/guard.ts`; as built after the 2026-09-21 head-to-head fix, groups
  D/E). `clusterByBehaviour` groups passers by P2P outcome vector ∪ perturbation-probe signature;
  on a ladder-class workspace the probe is the harvest/replay harness `LADDER_HARNESS`
  (`perturb.ts`, shared with the ladder-verdicts script): the goal's test calls are harvested
  once, perturbed, and replayed on every passer's tree. A cluster holding any `llm` member is
  represented by `preferLlmInCluster` — the LLM member with the most agreement (`Candidate.prior`),
  ties by edit cost. `decide`: **0 plausible** → `holdBestPartial`. **1 plausible** → commit,
  subject to the code-computed suspicion signals (`suspicionSignals`: `deletes_statement`,
  `duplicates_block`, `guards_other_variable`, `dead_guard`, and `adds_special_case` — the edit
  adds a conditional or a literal over the line it replaces, `specialCaseScore` > 0: `if x:`,
  `return 0`, `** 2`, the shape of every lone passer the head-to-head committed as an overfit).
  Any signal asks the Q16 advisory whenever a Jev request is left, inside the budget reserve too;
  a `general` p below 0.3 (`LONE_PASSER_HOLD_MAX_NOUL`) holds the passer as the `suspect` with an
  **unreleasable** hold (`unreleasable`: not released on the reserve, not at step end —
  `commitSuspect` returns null and the step ends on its honest partial or parks); two or more
  signals with 0.3 ≤ p < 0.7 (`LONE_PASSER_VOUCH_MIN_NOUL`) hold it while the step can afford the
  hold and release it as `possible overfit` — the only source of that note. One cluster that
  mixes a code seed and an LLM passer → commit the LLM member, no Jev request (GLM jev-off wrote
  16/16 gold-or-equivalent patches where it passed, the code seeds 7 overfits in 53 solves).
  **≥ 2 clusters → code first**, in this order (**as built 2026-09-21**, after the v2 head-to-head's
  class A′, llm-jev-headtohead-v2.md §9): (i) the cluster with a strict majority of the
  independent support (distinct source × site pairs, `majorityCluster`) → its representative
  (`preferLlmInCluster` when it holds an LLM
  member); (ii) **an all-seed split of equal support** — no cluster holds an `llm` member and every
  cluster carries the same `clusterSupport` (`seedOnlySplit`) — is decided by the **probe's
  majority**, never by the special-case count: on each perturbed input where the clusters' probe
  outputs differ the passers vote, a cluster casting one vote per member, and the cluster alone at
  the top of the per-input agreement count wins (`probeMajorityCluster`, the `probe_majority`
  `CodeRule`);
  when no cluster is alone at the top — a split vote on every differing input, or a probe that
  separates none of them — the code rules are exhausted and Jev decides; (iii) otherwise (a cluster
  holds an LLM member, or the supports differ) the representative adding the fewest special cases
  (`fewestSpecialCases`), when alone at the minimum. Why (ii) exists: the special-case count is
  right when the bug is a wrong expression and a guard would only fit the tests, and exactly wrong
  when the defect *is* a missing guard — it committed `stats` (`values.remove(mid)` +0c over the
  gold `if not values: raise` +1c/+1l) and `detect_cycle` (the least-guarded of three guards) as
  overfits, in both cases with the LLM sample gone so `preferLlmInCluster` and Q15/Q16 never
  entered; with equal support the near-duplicate worry `clusterSupport` answers cannot arise, so the
  member count behind a behaviour is evidence again. **Jev only on the residual tie** (and on an
  all-seed single cluster of ≥ 2): one Q15 `genuine_fix` Choice +
  Q16 `general_<xx>` Nouls over ≤ 20 representatives, with the **perturbation table** — the inputs
  on which the representatives' outputs differ, each output (`PERTURBATION_ROWS_MAX` 12) — in the
  state. **The all-overfit signature** — P(escape) ≥ `SUSPECT_ESCAPE_MIN` 0.5 ∧ max general Noul <
  `SUSPECT_NOUL_MAX` 0.3 — **drops the set**: nothing is held or committed, not now, not on the
  reserve, not at step end; the passers stay in `tried` and the search runs on with the batch's
  best partial held (before the fix the smallest edit was held and committed at step end as
  `possible overfit`; the head-to-head committed five such overfits where the baseline committed
  none). Otherwise the Choice argmax is committed under the §5.4 override rule, `llmFirst` before
  `byEditCost` on ties. Live on the two tasks the rule was written for (2026-09-21,
  `bench/results/llm-jev-v2-leftovers-{stats,detect-cycle}`): `stats` took route (ii) — *"the
  clusters split with no LLM member and equal support; committing template/guard_empty_raise …
  cluster_1 agrees with the passers' majority on the perturbed inputs (cluster_1 4/4, cluster_2
  0/4 … +1c/+1l vs +0c/+0l)"* — a weak (exception-class-only) overfit, 2/111 differential inputs,
  where v2's count-based pick was a strong one at 9/111; `detect_cycle` took route (i) with the
  LLM sample present — *"5 passers … in 2 behaviour clusters … cluster_1 3 members/support 2 …
  committing its representative llm/sample_0_0"* — a hunk that differs from the reference on
  `detect_cycle(None)` alone (1 of 500 random lists).
- **Proposal** (`src/synth/search/proposal.ts`). `patchMaxFiles(applied)` is
  `VERIFIED_PATCH_MAX_FILES` 4 for an `llm` winner and `MAX_PATCH_FILES` 2 for code sources;
  `selectionOf` reports `'llm'` when the winner's source is `llm`; the winner is re-expressed
  against the committed workspace as one unified diff.
- **Progress commits and partials.** Unchanged from §21: a held partial becomes a progress
  commit after the regression check (`MAX_PROGRESS_COMMITS_PER_GOAL` 3, `goals.ts`); the LLM sees
  the held partial as `## Best partial so far`; `llm` sites re-anchor by text after a partial
  shifts lines (`reanchorLlmSite`).
- **No establishing run; lane-baseline adoption** (`search/index.ts`). In llm-jev the jev-only
  establishing full-suite `run` is not proposed before the first patch (verified patches are
  code-`ok` in the risk stage): `needsRun = engineNeedsRun(mem) && !(llmJev && (lastChangeStep ===
  null || lastChangeStep === revertExecutedStep))`. After a commit, `adoptableLaneRun` adopts the
  lane's green full run as the baseline — no re-run — when every loaded Python file equals the
  lane's base (the touched ones its `after`) and no file appeared or vanished; a still-failing
  suite is re-run so the ledger can cluster from the full output. Once the engine has executed a
  full-suite run after the commit that is not green, that run contradicts the lane on this very
  tree: the lane run is not adopted (again) and the suite is re-run in the workspace
  (`engineRunContradictsBaseline`) — the engine's own claiming run is the authority, the lane
  supplies evidence only while the engine's run agrees with it. On repositories only the scoped
  regression run is adopted; the reproduction is always re-run in the workspace because it is the
  completion fact's evidence.
- **Completion evidence** (`proposal.ts completionEvidence`, `core/types.ts CompletionEvidence`).
  Every `run` proposed after an executed change is the claiming run; its `evidence.completion` =
  `{ledgerFixed: every goal fixed (≥ 1 goal), testsChanged: test files a commit touched,
  guardPending, repro: 'pass' | 'fail' | 'none' (the synthesizer's own workspace re-run), oracle:
  OracleOutcome | null, command}` **plus, on the repository class, `knownFailures`** — the scoped
  tests that already failed at the base commit (**as built 2026-09-21**). `core/types.ts` owns
  `CompletionEvidence`, so the count travels as an optional structural extension declared in the
  engine's own stage (`loop/stages/complete.ts KnownFailuresEvidence`,
  `ClaimingCompletionEvidence`) and is written by the synthesizer from `RepositoryMode.knownFailures`
  (`search/index.ts`, omitted when 0 — every QuixBugs / ladder run and every repository whose scoped
  suite is green at the base). `knownFailures` is the **base commit's** count: the first rebaseline
  of the run measures it (`atBaseCommit`) and every later rebaseline may only lower it — a commit
  that fixed one of them — never raise it, so a regression this run caused can never travel as a
  pre-existing failure; a resumed run keeps the persisted count for the same reason. The engine's
  `isCompleteByFact` (§22.6) ANDs it with its own parsed run, comparing against the declared count
  instead of against zero (`unexpectedFailures`).
- **Revert route** (`search/index.ts revertDue`, `finishRevert`, `rollbackUnexecutedPatch`;
  `proposal.ts proposeRevert`). Triggers: (1) the engine's suite run after the commit passed
  fewer tests than the pre-patch baseline (the scoped part on repositories), or the synthesizer's
  own fresh baseline did; (2) as built — the window carries no test ids, so §6.5's "a goal test
  in `newlyPassing` fails" is read from the synthesizer's own run: when the engine's full-suite
  run after the commit fails tests (or passes none) the baseline does not know
  (`engineRunContradictsBaseline`), the suite is re-run in the workspace this step (never the
  lane's run: `adoptableLaneRun` refuses while the engine's run disagrees), and a goal test the
  commit's `evidence.newlyPassing` showed that fails in that run re-opens the goal and reverts.
  The reverse diff of `mem.committed.at(-1)` is proposed as a `patch` whose
  goal starts with `revert` (`revert_last_change`) — no LLM, no Jev; risk is code-`ok` when every
  target is recoverable (`recoverableRevertOk`); the candidate stays `tried`, the goal re-opens
  and its localisation cache is dropped (`workspace_disagreed`); once per committed patch
  (`scratch.reverted`); a blocked or declined revert is re-proposed once, then abandoned; no
  claiming run follows an executed revert — the search resumes.

### 22.6 The engine-side rules (`src/loop/`)

- **Dispatch.** `runStep` skips intent and context in `llm-jev` (`stage = tripped ? 'replan' :
  'propose'`); the propose stage is `runSynthStage` with `draft.proposer = 'synth'`, or the
  generic `runProposeStage` with `draft.proposer = 'generic'` when `synthesizerHandles()` is false
  (below). `createEngine` requires `EngineOptions.synthesizer` in `jev-only` and `llm-jev`;
  `usesJev()` stays true for `llm-jev` and every branch it guards is edited to compute or skip.
- **The generator channel.** `generate(draft, req, attempt, sample?)`: with `sample`
  (`SampleOptions`) the sample's signal is linked to the engine's (`linkSample`), a sample already
  aborted when it arrives is rejected before any event, row or metered token, `generator:start /
  delta / tool-delta / end` carry `sample`, `retryHooks` are keyed per sample (sample 0's waker is
  the status line's, the rest in `sampleWakers`; `retryNow()` wakes all), and `generatorMs` is the
  batch wall. A sample aborted by its deadline or a loser cancellation — or failed after it had
  streamed — is metered from an estimate by `recordUnfinishedSample`: input tokens = a finished
  same-prompt sibling's `prompt_tokens` else prompt chars / 4, output tokens = streamed chars / 4,
  cost by `estimateCostUsd` (the sibling's served rate → the run's mean generator rate →
  `EngineOptions.generatorPricing` (the resolved config, passed by `src/cli/session.ts`) → the
  built-in table row → NaN, which fails closed as `budget:unpriced`); `meter.add('generator')`
  sees it, and the `generator.jsonl` row carries `sample`, `purpose`, `cancelled: true`,
  `usage.estimated: true` and `stopReason` `timeout | cancelled | error`. `flushGeneratorRecords`
  runs after `runSynthStage` exactly as after `runProposeStage`; a discarded step still flushes its
  rows (`absorbDiscardedTiming`). `jev-only` keeps throwing if the channel is ever reached.
- **Harm-only risk** (`stages/risk.ts runHarmOnlyRiskStage`). `codeRiskReason` decides before any
  Jev request: `read` → ok; `run` → ok iff `isVerificationRun` (one plain invocation of the
  detected test command, no shell composition); `done` → ok iff the engine's own passing, current
  run verifies it (`verifiedCompletion`); `patch`/`edit`/`write` → ok iff `verifiedPatchOk`
  (evidence verified, `newlyFailing = []`, 1–4 non-test workspace targets) or
  `recoverableRevertOk`. The returned `RiskAssessment` is `codeOkAssessment`: synthetic level-0
  dims at confidence 1 with `reason: "risk 0.00 (ok) by code: …"` so the TUI and `confirm()` read a
  full record. Everything else asks Q20's two Scores with `gating = HARM_DIMENSIONS`.
- **Code intent** — `codeIntent(kind)` (`engine.ts`): `verify` for `run`, `finish` for `done`,
  `investigate` for `read`, `edit` otherwise; probability, confidence, paired Noul and
  `planStillValid` all 1; the `intent` event is emitted after `proposal` with `verdict: 'code'`
  (`ChoiceVerdict` and `DecisionVerdict` gained the member in `core/types.ts`).
- **Code judge** (`stages/judge.ts runCodeJudgeStage`, `codeJudge`). On a `run`: `succeeded` = the
  suite passed — **as built 2026-09-21, "passed" means nothing failed beyond the baseline's known
  failures** (`unexpectedFailures(parsed, run.knownFailures) = 0` with `passed > 0`; with none
  declared that is the original `failed = errors = 0` and the runner's own `allPassed` is required
  too, since with known failures the runner exits non-zero by construction); a non-test command's
  exit code; the recorded `tests_pass_unparsed ≥ 0.85` when the parser read nothing.
  `errorPresent` = the parser counted
  errors **the baseline did not already have** (`errors > 0 ∧ unexpected > 0`; the judge's
  `error_present 1.00` on `sympy-11618`'s 43 pre-existing collection errors is what tripped its
  replan), `newInfo = 0`, `tests` from the parsed counts, `source: 'code'`; a claim is accepted
  (`judged: 1`) iff the suite passed or its goal tests (`ledgerGoalsOf`: the ledger item's first
  test, widened to `evidence.goalTests`) are all in the `newlyPassing` the executed counts confirm.
  `draft.claimProbabilities` holds the code verdicts so `commit()` takes the `{kind: 'judged'}`
  plan path; on `patch`/`read`/`edit`/`write` nothing is judged or asked (`judge: null`); on a
  `done` Q22 alone is recorded and the claims follow `verifiedDone`.
- **Completion by fact** (`stages/complete.ts isCompleteByFact`, `engine.ts completeAfter`). A
  `run` completes the run when it executed the workspace test command, the parser read
  `passed > 0` and **no failure beyond the baseline's known ones**
  (`unexpectedFailures(parsed, knownFailuresOf(completion)) = 0`; with none declared that is the
  original `failed = errors = 0`, and the runner's own `allPassed` is required too) — or
  `tests_pass_unparsed ≥ 0.85` when it read nothing —
  no change was executed at or after it (`testsCurrent` from `lastChangeStep`), and
  `completionEvidenceHolds`: `ledgerFixed`, `testsChanged = []`, `!guardPending`, the executed
  command equals `completion.command` when present, and — whenever an oracle was sought or a
  reproduction ran — `repro = 'pass'` with `oracle ∈ COMPLETING_ORACLE_OUTCOMES` (`valid`,
  `valid_weak`, `weak_network`; never `llm_valid` / `llm_weak`, never a search that found
  nothing). A `done` completes only as a noop the engine's own passing, current run verifies; a
  rejected `done` leaves the note `done rejected: no passing, current run verifies it
  (task_complete=… recorded only)`. `task_complete` is recorded, never consulted.
- **Generic fallback via `handles()`** (`engine.ts synthesizerHandles`, `src/synth/index.ts
  synthesizerHandles`). Decided once per run from the workspace listing: true when there is a
  non-test `.py` file and either a QuixBugs/pytest layout with a detected `testCommand` or a
  repository workspace (`isRepositoryWorkspace`). When false the step proposes through the
  generic `propose_action` sample with `draft.proposer = 'generic'`: the system prompt's reviewer
  sentence is the `llm-jev` variant (`src/provider/prompts.ts`: patches verified in shadow lanes,
  unverified actions gated on harm only), plan claims take verbatim evidence and a `done` stops
  the run as `generator_done` — both keyed on the flag `proposer === 'generic'`, not the mode.
  `StepRecord.proposer` is recorded only in this mode; a synthesizer without `handles` covers
  everything.
- **Timing.** `stepTiming` adds `synthMs` and computes `harnessMs` net of it; `draft.synthJevMs`
  is the Jev latency spent inside the synthesizer.

### 22.7 Provider details for GLM (`src/provider/openrouter.ts`, `types.ts`, `mock.ts`)

- **Reasoning is mandatory → effort low.** Live on 2026-09-21 (stage-2 probe and the §10.2 probe,
  `experiments/results/llm-jev-probes-off.md`): `reasoning: {enabled: false}` is HTTP 400
  "Reasoning is mandatory for this endpoint and cannot be disabled" on every `z-ai/glm-5.3*` id;
  the models API lists `reasoning.mandatory: true`, efforts `max | high | low`, default `max`.
  The client sends what it is asked and never rewrites (`reasoningOf` discriminates on the member
  present, so `{effort}` never degrades to `reasoning: {}` = effort `max`). The mode's default is
  therefore `LLM_DEFAULT_REASONING = {effort: 'low'}` with the reasoning-on `max_tokens` base of
  3,000 (`LLM_DEFAULT_GENERATION`, `src/synth/llm/source.ts`), used by the L1 rounds and the L2
  writer; the `jev-off-tuned` arm sends the same `reasoning` at its own base of 1,500. Contract 1.2 keeps `ReasoningEffort = 'low' |
  'medium'` verbatim from the design, so `high` is not requestable and `medium` is not a GLM
  effort. Probe with effort low (`llm-jev-probes.md`): 24/25 valid, valid p50 3.2 s / p90 48.2 s,
  ≈ 332 reasoning tokens per call, 0/76 hunks misanchored, 67 % distinct patches per round.
- **Once-doubling `max_tokens`.** A `finish_reason: length` sample is dropped (status `length`);
  the goal's next round doubles the base once (`lengthGoals`, `maxTokensFor`); L2 never doubles.
  The tuned provider re-issues the same request once at double `max_tokens` and sums both calls'
  usage into one result (`src/bench/tuned-provider.ts`).
- **Body mapping** (`buildOpenRouterBody`): `seed` (validated integer), `reasoning`,
  `providerPrefs.requireParameters` → `provider: {require_parameters}`, `parallel_tool_calls:
  false` with tools, `usage: {include: true}`. The stream reader (`consumeStream`) records the
  chunk `id` → `GenerateResult.generationId`, the response `provider` → `servedProvider` (both
  sanitised like a request id), `completion_tokens_details.reasoning_tokens` →
  `TokenUsage.reasoningTokens` (0 is a reading, absent stays absent), and the length of
  `delta.reasoning` for a cancelled stream.
- **Served rate.** `usage.cost` from the accounting frame is what OpenRouter bills and wins
  whenever present; the pricing table is a fallback. The endpoint serving GLM flash billed
  $0.15 / $0.50 per M — 5/3× the models-API table (DECISIONS 2026-09-21 "Default generator is
  OpenRouter"); the synthesizer's estimates use `LLM_SERVED_PRICING` at that rate and the bench
  records it as `servedRate` (`src/bench/conditions.ts GLM_FLASH_SERVED_RATE`);
  `config/defaults.ts` still lists the table rate ($0.09 / $0.30).
- **Cancellation and estimates.** An aborted sample yields no `GenerateResult`: `withRetry`
  rethrows `signal.reason`, and when the abort landed on an open stream (headers received) the
  provider first calls `GenerateOptions.onCancelled(CancelledGeneration)` — facts only:
  `generationId`, `servedProvider`, `model`, `text`, `toolChars`, `reasoningChars`, and `usage`
  only when the accounting frame had already arrived (priced like a completed call). The estimate
  itself is the engine's (`recordUnfinishedSample`, §22.6) and, inside the synthesizer, the
  source's (`estimatedSampleUsage`: sibling prompt tokens + `max_tokens` output at the served
  rate, §22.3) — two ledgers with two purposes: what the run pays (the meter) and what the step's
  LLM counter charges. The §10.2 cancellation probe read back billed = 0.90× the estimate over two
  samples; §8.1 keeps booking cancelled samples at full price. The mock provider
  (`src/provider/mock.ts`) scripts N samples by `opts.sample` (function-form `turns`), streams the
  tool-argument JSON in `deltaChunkSize` pieces so a signal can land mid-arguments, honours
  `stopReason` / `generationId` / `usage.reasoningTokens` on a turn and implements `onCancelled`
  for parity. The Anthropic provider ignores `seed` / `reasoning` / `providerPrefs`, surfaces
  `message.id` as `generationId` and has no `servedProvider`.

### 22.8 Bench arms and per-condition pinned generation (`src/bench/`)

`CONDITION_ORDER = ['jev-on', 'jev-off', 'jev-only', 'llm-jev', 'llm-sieve', 'jev-off-tuned',
'jev-on-next', 'jev-on-next-nofast']` (`conditions.ts`; `BenchCondition = EngineMode | 'llm-sieve' |
'jev-off-tuned' | 'jev-on-next' | 'jev-on-next-nofast'` in `core/types.ts`). The two attribution arms are bench-side substitutions on an existing engine
mode (`engineModeOf`): `llm-sieve` runs the `llm-jev` engine with the stub decider and the
synthesizer in `mode: 'llm-sieve'`; `jev-off-tuned` runs the `jev-off` engine behind the tuned
provider. The user's generation config never reaches an arm: `pinnedGeneration(condition,
model)` is recorded verbatim in `summary.json.conditions` and is what the requests send.

| Arm | Engine | Proposer | Pinned generation | Decider | Notes |
|---|---|---|---|---|---|
| `jev-off` | generator-only (`src/loop/generator-only.ts`, untouched since `2a92d0b`) | generator | `temperature null, maxTokens 4096, reasoning null, deadline none, lengthHandling none` — exactly the checked-in baseline runs | none | the baseline of criteria 1–4 |
| `jev-off-tuned` | generator-only behind `createTunedProvider` | generator | `maxTokens 1500, reasoning {effort: 'low'}, deadline 20 s (30 s on SWE/Terminal-Bench, per suite), lengthHandling double-once, plan capped at 200 chars by one added system sentence` | none (a `jev-off` engine) | attribution control for generator hygiene; a call past the deadline is aborted, metered from an estimate and returned as `GenerateResult{stopReason: 'timeout', toolCalls: []}`, which `src/loop/stages/propose.ts` (`DROPPED_CALL_STOP_REASON`) ends the step on without a retry; the wrapper's ledger (`timeouts`, `doubled`) goes on the record |
| `jev-only` | full engine + synthesizer, `NullProvider` | synthesizer | inert (no LLM) | Jev | the no-generator reference; any generator call invalidates the record |
| `llm-jev` | full engine + synthesizer **and** the real provider | synthesizer | the one `SynthesizerGeneration` object `LLM_DEFAULT_GENERATION` — `reasoning {effort: 'low'}, maxTokens 3000, sampleDeadline {10 s, 20 s, repo 30 s}, sampleTemperature {0, 0.8, 0.6, 1.0}` — handed to `createSynthesizer({generation})` and echoed back as `Synthesizer.generation`; the flat record fields (`maxTokens`, `reasoning`, `deadlineMs`, `sampleTemperatures`, `lengthHandling: double-once`, `servedRate`) are derived from it | Jev | the candidate; generator calls are recorded per sample, never asserted zero |
| `llm-sieve` | as `llm-jev` with `createStubDecider()` in the decider slot | synthesizer | same object as `llm-jev` | stub (`STUB_DECIDER_MODEL`, Noul 0.5, Choice = first non-escape option, Score level 0; `usage.calls: 0`, its own count travels as `stubbedJevRequests`) | attribution control for criterion 5; **not wired**: `createSynthesizer` throws for `mode: 'llm-sieve'`, so the runner writes an `engine_create_failed` record instead of measuring a different arm under this name |
| `jev-on-next` | full engine, `mode: 'jev-on'` (`engineModeOf`), with `EngineOptions.fastPath: 'auto'` and `routers: 'on'` | **generator** (the fast path is a per-step detour, not the arm's proposer, so `usesSynthesizer` is false) | the `jev-off-tuned` object — `maxTokens 1500, {effort: 'low'}, deadline 20 s / 30 s on repositories, lengthHandling double-once` — plus the pinned `S2Generation` block (`hedges {perRound 1, 3–8 s, 2 × TTFB p50}, prefix 'byte-stable', reasoningMaxTokens 256`) | Jev | contract 1.9, `docs/LLM-LOOP-DESIGN.md` §8.1; `validateOptions` refuses it at any `--concurrency` but 1 |
| `jev-on-next-nofast` | as `jev-on-next` with `fastPath: 'off'` | generator | the same object | Jev | the paired same-build control §8.5 clause 4 rests on; without it a `jev-on-next` win confounds tuned generation, S2, the routers and the fast path |

The runner (`runner.ts`) refuses a synthesizer arm whose synthesizer does not echo the arm's mode
and, for the LLM arms, the very generation object (`synthesizerMismatch`), records
`os.loadavg()` at engine start, the generator-call summary from `generator.jsonl`
(`generator-records.ts`), `servedRate`, and the per-step `synth` summary from `steps.jsonl`
(`timing.synthMs`, `proposer`; `StepRecord.verify` is typed but not filled yet, §22.10). The
head-to-head (`headtohead.ts`: Wilson intervals, exact one-sided sign test on discordant pairs,
exact one-sided Wilcoxon signed-rank on paired wall, cost ratios, criteria 1–5 with the failed
ones named first) is rendered into `comparison.md` by `report.ts` whenever an LLM arm sits beside
`jev-off`, and by `experiments/llm-jev/headtohead.mts` across several results dirs with
per-arm verdict files. The bench CLI (`src/cli/args.ts CONDITIONS`) keeps its own hard-coded allow-list, which today reads
`jev-on, jev-off, jev-only, llm-jev, llm-sieve, jev-off-tuned` — it is **not** derived from
`CONDITION_ORDER`, so `--conditions jev-on-next` is rejected at the CLI boundary even though
`parseConditions`, `isBenchCondition` and `runBench` all accept it. Adding the two rows to that
constant is the one change the wave needs outside `src/bench/**`, and it is the only reason the arm
is not yet reachable from `bin/jevcode.js bench` (and therefore from `experiments/harness-next/quick.mts`,
which shells out to it). `test/unit/bench/next-arms.test.ts` pins the gap so it cannot be forgotten.

**contract 1.9 (Fastlane) — the wave's arms and their measurement.** `jev-on-next` and
`jev-on-next-nofast` (`docs/LLM-LOOP-DESIGN.md` §8) are bench-side substitutions on `jev-on` in
exactly the sense `jev-off-tuned` is one on `jev-off`: no new `EngineMode`, no new engine, three
mechanisms switched on per arm and PINNED in `summary.json.conditions[arm].mechanisms`
(`armMechanisms`), never read from the environment. The measurement side is
`src/bench/next-arms.ts` — the recorded iteration-1 reference (fresh 18: `llm-jev` 12/18,
`jev-off-tuned` 9/18, 26.0 s against 19.7 s on the 8 both-solved; in-sample 28: 27/28), the five
blocking rows R-a…R-e of §8.3, the pre-registered predictions (a)…(f) of §8.4 and the five-clause
accept rule of §8.5 — and it is fed by the §5.5 bridge: `step-records.ts` now folds `fastPath`,
`router`, `riskSource`, `jevUnavailable` and the S2 members of `verify` out of `steps.jsonl` into
`StepsSummary`, without which every one of those fields is written to the run directory and is
invisible to every bench table. The recorded rows are a *reference*, not a same-build baseline:
they were taken at `751e3bf` and `main` carries the nine unmeasured changes of `oos-iter-2`, which
is why clause 4 rests on the `jev-on-next-nofast` control instead. `report.ts` prints the wave's
columns in `comparison.md`; `experiments/llm-jev/headtohead.mts` prints the three §8 sections when
the arm is present; `experiments/fastlane/quick-table.mts` adds the fast-path, router-wait and TTFB
columns and folds R-a and R-b into the §5 accept rule; `experiments/harness-next/quick.mts` takes
`--arm` (rings 1 and 2 used to hard-code `llm-jev`, so a Ring-2 run of this wave would have read
zeros for a reason that had nothing to do with the fast path) and clamps that arm to concurrency 1.

Two consequences of pinning the mechanisms are recorded here rather than left to be discovered from
a table. **First, pinning an option is not enough: both mechanisms are resolved env-FIRST inside the
engine** (slot C's `resolveFastPathOption` reads `JEVCODE_FASTPATH` before `EngineOptions.fastPath`,
in both directions; slot B's `routersOn` ORs `JEVCODE_ROUTERS=on` in). An exported
`JEVCODE_FASTPATH=off` would run `jev-on-next` disarmed while `summary.json` recorded `'auto'`, and
an exported `JEVCODE_FASTPATH=auto` would run the `jev-on-next-nofast` **control** armed while it
recorded `'off'` — destroying the one-mechanism contrast clause 4 rests on, silently and in the
flattering direction. `runBenchWithSources` therefore calls `conditions.ts pinMechanismEnv()` before
any engine is built, unconditionally, and logs each switch it removed; after that the pinned value
is the effective one. **Second, `armMechanisms` returns `fastPath: 'off'` for the six older arms**,
which once slot C lands is a deliberate divergence from the product default (`'auto'` in `jev-on`):
a bench `jev-on` row measures the engine *without* route R9, because it is the same-build no-fast-path
reference the wave is read against. §8.5's note that the default-mode flip is "a separate decision on
these rows" is exactly this: the `jev-on` bench row is not a measurement of the shipped default.

### 22.9 Deviations from `docs/LLM-JEV-DESIGN.md` recorded in the stage reports

Each implementer's `deviations_from_design`, grouped by stage; the review defects that forced
them are recorded alongside.

**Stage 1 — generator channel, mode plumbing, code-fact stages** (`a0f7fbc`, `64c8d3e`).
- A verified `done` also completes by fact (`isCompleteByFact` returns true for a noop `done`
  the engine's own passing, current run verifies); §6.6 defined completion on the claiming run
  only, but a run whose synthesizer proposes `run → done` would otherwise never stop `complete`.
- `CompletionEvidence` adopted the §6.6 shape exactly plus an optional `command`; the
  "repository class" condition is inferred from the evidence (`oracle !== null || repro !==
  'none'`), so a repository run whose oracle search found nothing never completes by fact;
  `testsCurrent` is computed from `lastChangeStep`, not `lastTestRun`, so the unparsed-runner
  stand-in can still complete.
- `OracleOutcome` moved into `core/types.ts` (core cannot import from synth) with the two
  `llm_*` members; `ChoiceVerdict` moved there too so the `intent` event can carry `verdict:
  'code'`; `DecisionVerdict` gained `'code'`.
- `recoverableRevertOk` recognises the revert by the goal prefix `revert` — no typed marker exists
  on `Proposal` (TODO in `risk.ts`; `proposeRevert` keeps the prefix).
- No provisional intent is emitted before the proposal (none would be a fact); the `intent` event
  follows `proposal` in this mode.
- Cancelled-sample cost chain: sibling served rate → run mean → `EngineOptions.generatorPricing`
  (new, optional) → built-in table → NaN (unpriced fails closed, never $0). A request that failed
  before any byte streamed leaves no row; a sample already aborted when it arrives is rejected
  without a row, so `calls` keeps meaning served calls.
- Retry wakers: the existing `retryWaker` for sample 0 plus `sampleWakers: Map<number,
  AbortController>`; `retryNow()` wakes all.
- `src/checkpoint/store.ts` gained `'llm-jev'` in its mode list (needed for `--resume`).
- `StepRecord.verify` added as the typed contract only; the plumbing was left to stage 4 (and is
  still open, §22.10). `StepDraft.proposer` is recorded only when non-null so the other modes'
  records are byte-identical.
- In `jev-only`, `flushGeneratorRecords` now also runs after `runSynthStage` (a no-op) and the
  synth wall is measured but not reported.

**Stage 2 — GLM provider details** (`61c15b6`, `87b0be1`).
- `reasoning: {enabled: false}` is HTTP 400 on GLM (§22.7); the working call is `{effort:
  'low'}`; `medium` is not a GLM effort. `ReasoningEffort` stays the spec's `'low' | 'medium'`, so
  `high` cannot be requested through the contract.
- `GenerateOptions.onCancelled(CancelledGeneration)` was added to the contract (an addition to
  §9.3): the generation id is visible only inside the stream, and §4.8 wants it on the cancelled
  record. It carries facts only; the estimate is the engine's.
- `GenerateResult.servedProvider` added (not in §9.3) for the served-rate accounting.
- `reasoning_tokens: 0` is surfaced as `0` (a reading), absent stays absent.
- `providerPrefs.order` was dropped (the spec has only `requireParameters`), so upstream pinning
  through `provider.order` is not reachable from a request.
- Anthropic surfaces `message.id` as `generationId` and checks `signal.aborted` per record like
  OpenRouter; the mock streams tool-argument JSON in pieces and implements `onCancelled`.

**Stage 3 — the LLM source** (`2651024`, `24fc2d7`).
- `src/synth/llm/types.ts` (not in the §9.2 file list) held local copies of the contract until
  the integration commit `652e5bf` replaced them with imports from `core/types.ts`.
- `near_line` settles several matches only when one is strictly nearest inside ±20 lines (a pure
  window filter could never disambiguate two copies in a small file).
- A deletion hunk is primary only when every hunk deletes, so the site keeps a replacement text
  whenever it can.
- The dry-run applier `applyLlmCandidate` lives in `candidates.ts`; stage 4 taught the shipped
  `verify/apply.ts applyCandidate` the same span rule. The design's §4.7 step 3 premise — that
  `codeTokenKey` tokenises a dedenting block to `''` — does not hold (`tokenizeFragment` is
  lenient); the real gap the `textSha` rule closes is the whitespace-insensitivity of the
  token-key check (a reformatted span line applies blind under the token check and is refused as
  `stale llm site` under the hash). Recorded here as the correction; the design text is unchanged.
- The source's cancelled / timed-out / errored estimate books `max_tokens` output at full price;
  the engine holds the finer streamed-chars estimate.
- The round cache is in-memory per source; `exportCache()` persists shas only. Dedupe is
  `sha12(diff)` after normalising the hunk's `new` text (CRLF, trailing whitespace, trailing blank
  lines).
- Q17 with > 8 distinct samples: the Choice covers the first 8 in arrival order, the Nouls every
  sample in chunks ≤ 50; hint h4 is scheduled only on the QuixBugs class.
- `release()` joined `fire / collect / cancel` for the stagger; `fire()` supersedes a cancelled or
  fully-fired round that is still draining and refuses only a staggered round awaiting
  `release()` (`round_open`); `cancel()` returns a promise resolved at round close.
- A rejecting compile check drops the patch as the new `compile_failed` (counted apart from
  `syntax_error`); provider errors are booked at the estimated full cost.
- L2 charges `usdLeft` only (one round per run, outside the L1 round/sample counters);
  `reasoningEnabled` keys on `'effort' in reasoning`.

**Stage 4 — wiring into the search** (`c8f0939`, `67208b5`).
- The adapter is `src/synth/search/llm.ts` (`SubGoalLlm`, `LlmRound`, `createSearchLlm`), not
  code inside `src/synth/index.ts`; `SubGoalDeps.llm` is an injectable interface so the loop is
  tested with the fake in `test/unit/synth/search/controller-fakes.ts`.
- The §7.1 repository step-1 overlap is [scoped baseline ‖ L1 round] only (`fireEarlyRound`
  before the scoped run; the search takes the round from `mem.llm.early`); the reproduction runs
  of arriving candidates start after the baseline because the runner's classification needs it.
- Lane-baseline adoption compares the whole loaded Python tree byte for byte and adopts only a
  green run (§22.5), not "the sha256 of every touched file".
- The revert triggers are the count (`passed` against the pre-patch baseline) and, since the
  window's `judge.tests` carries no test ids, a second trigger read from the synthesizer's own
  re-run of the workspace rather than from the engine's parsed ids: the engine's claiming run
  contradicting the baseline re-opens the goal whose test fails in that re-run (§22.5 "Revert
  route"); the lane run is adopted as the baseline only while the engine's run agrees with it
  (`adoptableLaneRun`). `revert_last_change` is a `patch` whose goal starts with `revert`; no
  claiming run follows an executed revert.
- §6.2's "one cluster → commit at once, no Jev" applies only to a cluster holding both a seed and
  an LLM member; an all-seed single cluster of ≥ 2 keeps Q15/Q16 (all-overfit detection), so
  jev-only behaviour is identical.
- Q6-fallback batching and full-criteria Noul chunks are opt-in (`batchQ6Fallback`,
  `fullCriteriaNouls`) and wired only in llm-jev; the measured shapes stay for jev-only.
- `llmUsdLeft = min($0.02, (spendCap − spent) / stepsLeft)` uses the synthesizer's own ledger of
  LLM spend (`SynthesisContext` exposes no meter) with `stepsLeft = maxSteps − step + 1`.
- The stagger releases also when the top site has no seeds; the grace waits
  `min(LLM_GRACE_MS, deadline left)` for the first arrival regardless of structural signals, at
  any seed batch while the round is open and nothing has landed; a round's deadline restarts at a
  stagger release; spent LLM counters still replay the site cache.
- The grace batch runs on a queue of its own (`deps.createQueue`) rather than sizing the shared
  queue's dispatches; the LLM phase itself keeps the shared queue.
- RANK collects "N−1 arrived or deadline"; the best-guess search drains the whole round after
  ranking the seeds concurrently; an L1′ fired after an open RANK round cancels it as `budget`
  first (`CancelReason` has no `superseded`).
- The RANK-mode LLM branch orders with Q17 (`deps.llm.order`), never `deps.rank` (which throws on
  off-site candidates); job priors per class as in §22.5.
- `convertSample` reserves the diff sha before the awaited compile check (concurrent samples with
  the same diff were all passing the dedupe — found by the adapter test).
- After `--resume`, `mem.committed` is not persisted, so the resumed claiming run's evidence is
  degenerate (before = after = the fresh baseline, `newlyPassing []`) but still carries the facts.
- `handles()` reads §9.4 literally: a QuixBugs/pytest layout without a detected `testCommand`
  falls back to the generic proposer.
- `orderSources('LLM')` and the `#LLM` exhausted key remain in `subgoal.ts` for switch
  exhaustiveness; they are unreachable (`visitLlm` bypasses `visitSource`).
- `StepRecord.verify` plumbing was not done (`SynthesisContext` has no channel to hand the
  counts to the engine); the counts live in `GoalSearchTrace.llm` and the proposal's `rawText`.

**Stage 5 — bench arms and measurement** (`304be21`, `9376b75`).
- `jev-off-tuned` sends `{effort: 'low'}` (the design table said `{enabled: false}`) with base
  1,500 and one doubling; the synthesizer arms use the reasoning-on base 3,000.
- Drop-not-retry is implemented at the provider boundary (`generator-only.ts` untouched per
  §9.1): a dropped call returns a `GenerateResult{stopReason: 'timeout', toolCalls: []}`, and
  `src/loop/stages/propose.ts` (`DROPPED_CALL_STOP_REASON`, 13 lines of engine code) ends the
  step on it without its malformed retry; `malformed` excludes dropped rows. The deadline is per
  suite (20 s QuixBugs/ladder, 30 s SWE/Terminal-Bench), not per class detected at run time.
- The plan cap is one added system sentence (`planCapSentence`), not a grammar change.
- `os.loadavg()` is recorded on the bench record, not in `run.json`.
- The stub decider returns `usage.calls: 0`, so `jevRequests` counts requests actually made; the
  stub's count travels as `stubbedJevRequests`; `jev.jsonl` / `decisions.jsonl` still record its
  answers under model `none (llm-sieve: jev stubbed)`.
- Metrics that need synthesizer-reported facts are read from `steps.jsonl`; `refusedSteps` is
  the existing blocked + declined; `l2FalsePositive` and the `synth.*` sub-buckets
  (`generatorMs` / `jevMs` / `laneMs` / `graceMs` inside `synthMs`) are not computed (no data
  source yet).
- `SynthesizerOptions.mode` is optional (the session's `createSynthesizer({decider, redact})`
  call could not be edited at the time); the compile-time obligation became a runtime one — the
  runner refuses an arm whose synthesizer does not echo the mode and the pinned generation, and
  the factory throws for an unwired arm. `SynthesizerGeneration` (`core/types.ts`) carries only
  what the LLM source consumes; the stage-3 defaults were changed to `{effort: 'low'}` / 3,000.
- Probe 3 (Jev arbitration over (seed line, LLM hunk) pairs) is not implemented; the design's
  three probe scripts are one `experiments/llm-jev/probes.mts` with flags; prompts are QuixBugs (5)
  + ladder (3) rather than QuixBugs + SWE.
- Wilcoxon signed-rank is exact for any n; medians use the nearest-rank estimator of
  `bench/metrics.ts` everywhere (§1.2's 124 s QuixBugs median reads 94 s under it).
- The §10.2 decisions paragraph (a)–(d) was added to the design's §10.2, including the 20 s cap
  against the measured 48 s p90.

**Integration and session** (`652e5bf`, `626fc40`). `src/core/types.ts` is the single contract
source: the stage-2 `*Ext` types and the stage-3 local copies were deleted and `provider/*` and
`synth/llm/*` import the core names. `src/cli/session.ts buildSynthesizer` now builds the
synthesizer against `SynthesizerOptions` with `mode: 'llm-jev'` and `LLM_DEFAULT_GENERATION`
under `--mode llm-jev`, and passes `config.generator.pricing` as `EngineOptions.generatorPricing`.

**Review fixes (2026-09-21, groups A–C).** Deviations the review closed; the bullets above
describe the code as it now stands.
- The streamed batch no longer waits for the round to end: a batch begun while the queue streams
  ends on its first plausible outcome in both runners (`JobQueue.streaming`), the controller
  decides at once and cancels the losers as `commit`, and re-enters the stream when the guard
  holds; parked workers are released through `VerifyQueue.next(signal)` / `awaitNextJob` when
  dispatch stops, the step signal fires or the wall no longer fits a run (§22.2 row 4h, §22.5
  "Sieve").
- `phaseLadder` orders the repository class `['LLM', 'SEEDS', 'SKETCH', 'BEAM', 'WIDENED']`
  (§22.5 "The LLM phase"); design §4.2's `PHASES` stands for the other classes.
- `revertDue` gained the second trigger as built, and `adoptableLaneRun` refuses the lane run once
  the engine's full-suite run after the commit is not green (§22.5).
- The source's fire-time reservation is a hold, never a debit (`source.ts` `reservedUsd`; the
  counter is charged at settle), and the loop sizes the next round on the counter less that hold
  (`budget.ts llmRoundAffordable` / `llmHoldOf`, `subgoal.ts llmRoundsAvailable`, `decideLlmN`);
  a budget re-installed at a re-baseline carries `min(fresh, previous)` and leaves the hold to
  the source (`search/index.ts freshBudget`), since debiting it there would charge the samples
  twice.
- L2 runs its scripts in scratch copies under `<runDir>/tmp/synth/repro`
  (`search/index.ts LLM_REPRO_SCRATCH_DIR`; worktree copies when `ctx.workspaceInfo.git`, `cp -R`
  otherwise — no `.git` probe in the sandbox), behind the write/process code filters and the
  runtime network tell of design §4.10.

### 22.10 Open items

> **Swept 2026-09-22 at `d297b29` (finishing pass F21).** Five of the bullets below had closed and are struck in place with
> the landing commit rather than deleted, so the history of the claim survives. `test/unit/hygiene/doc-claims.test.ts`
> asserts, for every "not landed" claim still standing here, that the cited symbol really is absent from `src/**` — a bullet
> cannot silently rot a second time.

- ~~**The head-to-head is not yet reported.**~~ **CLOSED 2026-09-21/22.** Both artefacts the bullet
  gated on exist: `experiments/results/llm-jev-headtohead.md` and `-v2.md` (plus the `.oos` and
  `.tool` companions) and `docs/LLM-JEV.md`, whose dated entries run to OOS iteration 4. The section's
  numbers are measured, and every one of them carries its run ids and its load disclosure there.
  What is NOT measured, and is the standing gap, is `Ring 1 --jev off` at or after `main` `d297b29`
  (`docs/DECISIONS.md`, "the provenance of every Ring-1 `--jev off` number").
- **`llm-sieve` is not wired** in `src/synth/index.ts createSynthesizer` (it throws; the bench
  records `engine_create_failed`), so criterion 5 (attribution) and the per-question ablation
  cannot be measured yet. **STILL OPEN — owner: finishing-pass F06.** The second half of this bullet
  is struck: ~~`src/cli/args.ts CONDITIONS` does not list `llm-sieve` / `jev-off-tuned`, so the arms
  are reachable only through `runBench`~~ — `CONDITIONS` has carried all eight arms since `0fb7af3`
  (`src/cli/args.ts:308`), so the arms are typeable and only the synthesizer is missing.
- ~~**`StepRecord.verify` is typed but never filled**: `SynthesisContext` has no channel for the
  synthesizer's `GoalSearchTrace.llm` counts …~~ **CLOSED.** The channel is
  `SynthesisContext.reportVerify?: (counts: Partial<StepVerifySummary>) => void`
  (`src/core/types.ts:1985`), reported from `src/synth/search/index.ts` and written onto the record at
  `src/loop/engine.ts:5654` (`llm-jev` + `proposer === 'synth'` only, so `jev-only` rows are byte-identical).
  Contract 1.9 then added the S2 members (TTFB, hedge, cache) to the same block, and the warm plane added
  `verify.warm` (`StepWarmSummary`, `warm-plane-fix-2`). `l2FalsePositive` remains unmeasured — that is the
  "Unmeasured Jev behaviour" bullet below, not this one.
- ~~**Cancelled rows carry no generation id**: `src/loop/engine.ts` does not pass
  `GenerateOptions.onCancelled` …~~ **CLOSED** by the LLM-loop wave's §3.1 work: the engine passes
  `onCancelled` (`src/loop/engine.ts:3539`), holds the partial for its own row and forwards it to the
  synthesizer's callback when one was asked for. The §4.8 post-hoc `GET /api/v1/generation?id=`
  reconciliation is therefore possible from the records; whether it is worth its request is a separate,
  unfiled question. Cancelled samples are still booked at full price.
- **Default spend cap** for `llm-jev` is $2.00 (`src/config/ui.ts defaultRunSpendCapUsd`,
  "jev-on, jev-off and llm-jev all pay a generator"), not the $0.50 the design's §8.4 named.
- **First-round deadline vs the tail** — *addressed 2026-09-21, still to be re-measured.* The fixed
  20 s / 30 s cap cut 31 of 100 samples in the v2 head-to-head (61 % on QuixBugs, every timed-out row
  served by one provider whose served samples ran at p50 7–10 s). §22.3's adaptive deadline
  (`clamp(2 × served p90, class default, 45 s / 90 s)`) plus the 512-token reasoning cap on a slow
  provider replaces it; the gate stays `verify.timeouts / samples` ≤ 15 % on QuixBugs, now measured
  against the adapted deadline the round records (`LlmRoundSummary.deadlineMs`). A full suite has not
  been re-run since (the two leftovers runs served their samples in 6.7 s and 8.7 s, inside the
  class default, so the adaptation never had to fire).
- **Repository step-1 overlap** is two-way (scoped baseline ‖ L1 round); the reproduction runs of
  arriving candidates would need a runner that accepts a base without its baseline.
- **Typed revert marker**: `recoverableRevertOk` and `proposeRevert` agree on the goal prefix
  `revert`; a marker on `Proposal` would replace it.
- **Reasoning contract**: `ReasoningEffort` lacks `high` (a GLM effort) and includes `medium`
  (not one); `provider.order` pinning is not reachable; `config/defaults.ts` lists GLM flash at
  the table rate while the served rate is 5/3× (harmless while `usage.cost` is present).
- **Unmeasured Jev behaviour**: Q15/Q16 on (seed line, LLM hunk) pairs across distinct clusters
  (probe 3, design §10.2 item 3b; if < 8/10 the design says distinct-cluster ties fall back to
  the code rule); Q17's accuracy on multi-hunk diffs (whether it earns its $0.0003); Q18's
  accuracy on LLM prose (reported as the L2 false-positive rate once measured).
- **After `--resume`** the claiming run's evidence is degenerate (`newlyPassing []`) because
  `mem.committed` is not persisted; the completion facts still hold.
- **`handles()`** sends a QuixBugs/pytest layout without a detected `testCommand` to the generic
  fallback; the checked-in layouts detect pytest from `tests/`.
- ~~**Default mode.** `jev-only` remains the default …~~ **CLOSED 2026-09-22:**
  `DEFAULT_MODE: EngineMode = 'llm-jev'` (`src/config/defaults.ts:60`), flipped on the peer's verified
  head-to-head (`docs/LLM-JEV.md`, `experiments/results/llm-jev-headtohead-v2.md`), which is exactly the
  gate DECISIONS 2026-09-21 "The default-mode flip is gated on the head-to-head" named. The flip still
  pending is a *different* one — `llm-jev` → `jev-on`, gated on the arms named in DECISIONS
  2026-09-22 "The LLM-loop wave lands with both switches off".
