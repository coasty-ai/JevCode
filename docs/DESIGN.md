# JevCode design

Status: draft v1, 2026-09-19. Versions and adopt/reject items marked `[R]` are taken from
`docs/RESEARCH.md`; everything else follows the build prompt and
`~/Documents/jev-research/REPORT.md` (cited as REPORT §n). Deviations are listed in §16.

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
  bin/jevcode.js                 launcher: enable compile cache, import dist bundle
  src/
    cli/main.ts                  parseArgs, dispatch: run | config | bench | perf | --resume
    cli/args.ts                  flag schema shared by all commands
    config/{types,defaults,resolve,env,mask,validate}.ts
    errors.ts                    typed error hierarchy (§11)
    core/types.ts                shared contract: Action, Plan, Step, Events, Provider, Jev
    core/events.ts               typed EventEmitter for engine -> renderer
    core/hash.ts  core/atomic.ts  core/redact.ts  core/time.ts  core/json.ts
    jev/client.ts                port of lab.mjs raw()/ask(): fetch, retry, redaction, spend
    jev/types.ts  jev/validate.ts  jev/confidence.ts  jev/questions.ts  jev/mock.ts
    spend/meter.ts               SpendMeter: split generator/Jev, cap, typed BudgetError
    provider/{types,anthropic,openrouter,mock,sse,actions,prompts}.ts
    sandbox/{run,kill,paths,seatbelt}.ts
    workspace/{files,candidates,edit,patch,tests}.ts
    loop/engine.ts               the step loop (§6)
    loop/stages/{intent,context,propose,risk,execute,judge,complete,replan}.ts
    loop/{plan,window,loopdetect,budget,stop}.ts
    loop/generator-only.ts       Jev-off condition used by the bench
    checkpoint/{store,resume,run-id}.ts
    tui/{App,Transcript,Decisions,StatusLine,Confirm,useEngine}.tsx  tui/plain.ts
    bench/{runner,report,metrics,conditions}.ts
    bench/swebench/{tasks,loader,evaluator,predictions}.ts
    bench/terminalbench/{tasks,loader,evaluator,harbor-adapter}.ts
    perf/{first-frame,step-overhead,render-lag,jev-latency,main}.ts
  bench/data/swebench-verified-30.json      checked-in subset (instance records)
  bench/data/swebench-verified-30.gold.json gold patches, mocked bench only
  bench/data/terminal-bench/<task>/...      checked-in task dirs (instruction, tests)
  bench/harbor/jevcode_agent.py             Harbor installed-agent adapter
  test/unit/**  test/live/**  test/fixtures/**
  docs/RESEARCH.md  docs/DESIGN.md  docs/DECISIONS.md  docs/research/*.md
```

One package, ESM, `"type": "module"`, strict TypeScript with `noUncheckedIndexedAccess`,
`exactOptionalPropertyTypes`, `verbatimModuleSyntax`, `erasableSyntaxOnly`, no `any`
(lint rule: `@typescript-eslint` is *not* added; `grep -n ': any\|as any\|<any>' src` is a
CI check in `npm run typecheck`). Node pinned in `.nvmrc`, `engines`, and `.npmrc`
(`engine-strict=true`) `[R]`.

## 3. Configuration

Precedence, highest first: CLI flag > process env var > `./.env` > `<OPEN_ASSIST_PATH>/.env`
> config file > default. `.env` files are parsed with `node:util` `parseEnv`; they are read
into an isolated map, never into `process.env`.

| Setting | Flag | Env | Default |
| --- | --- | --- | --- |
| Generator provider | `--provider` | `JEVCODE_PROVIDER` | `anthropic` |
| Generator model | `--model` | `JEVCODE_MODEL` | `claude-sonnet-5` |
| Generator key | `--api-key` | `ANTHROPIC_API_KEY` / `OPENROUTER_API_KEY` by provider, or `JEVCODE_API_KEY` | none |
| Generator base URL | `--base-url` | `JEVCODE_BASE_URL` | `https://api.anthropic.com` / `https://openrouter.ai/api/v1` |
| Decider base URL | `--jev-base-url` | `JEV_BASE_URL` | `https://openrouter.ai/api/alpha/decisions` |
| Decider key | `--jev-api-key` | `JEV_API_KEY`, falling back to `OPENROUTER_API_KEY` | none |
| Decider model | `--jev-model` | `JEV_MODEL` | `typesafe/jev-1.13-20260917` `[R]` |
| Spend cap (USD, generator + Jev) | `--spend-cap` | `JEVCODE_SPEND_CAP_USD` | `2.00` |
| Max steps | `--max-steps` | `JEVCODE_MAX_STEPS` | `40` |
| Max wall time | `--max-wall` (e.g. `30m`) | `JEVCODE_MAX_WALL` | `30m` |
| Completion threshold | `--complete-threshold` | `JEVCODE_COMPLETE_THRESHOLD` | `0.85` |
| Workspace | `--workspace` | `JEVCODE_WORKSPACE` | cwd |
| Runs dir | `--runs-dir` | `JEVCODE_HOME` | `~/.jevcode/runs` |
| Open Assist path | `--open-assist-path` | `OPEN_ASSIST_PATH` | sibling `../open-assist` of the package if it exists |
| Config file | `--config` | `JEVCODE_CONFIG` | `./jevcode.json`, else `~/.config/jevcode/config.json` |
| Sandbox profile | `--sandbox` | `JEVCODE_SANDBOX` | `auto` (seatbelt on darwin, none elsewhere) |
| Generator pricing override | | `JEVCODE_PRICE_IN_PER_M`, `JEVCODE_PRICE_OUT_PER_M` | table in `config/defaults.ts` `[R]` |

Risk thresholds 0.3 and 0.7 are constants from the prompt, exported from
`loop/stages/risk.ts`, not configurable.

Validation happens at first use: `resolveConfig()` returns a `ResolvedConfig` with every
value plus its `source` (`flag` | `env` | `dotenv:<path>` | `file:<path>` | `default`);
`config.generator()` and `config.decider()` validate their section (key present, URL
parses, model non-empty, numbers finite and positive) on first call and throw
`ConfigError` naming the setting and the sources consulted. `jevcode run` renders its
first frame before either is called. `jevcode config` prints the resolved table with
secrets masked as `sk-or-…d4f2` (first 5 and last 4 characters) and the source column.

## 4. Core contract (`src/core/types.ts`)

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
export interface PlanItemDone { text: string; evidence: { step: number; judged: number } }
export interface Plan { done: PlanItemDone[]; remaining: string[]; openProblems: string[] }

// ---- execution ----
export interface ExecResult {
  ok: boolean; exitCode: number | null; signal: string | null;
  stdout: string; stderr: string; truncated: boolean; timedOut: boolean; durationMs: number;
}
export type ActionOutcome =
  | { status: 'executed'; exec?: ExecResult; summary: string; changedFiles: string[] }
  | { status: 'blocked'; reason: string }
  | { status: 'declined'; reason: string }          // human said no at review
  | { status: 'failed'; error: string };            // patch did not apply, path escape, ...

// ---- Jev ----
export type Question =
  | { type: 'noul'; instructions: Json; criteria?: { true: Json; false: Json } }
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
  probability: number;                   // P(chosen) : noul p, choice p_max, score P(argmax)
  confidence: number;                    // harness-computed (§5.3)
  verdict?: 'ok' | 'review' | 'block';   // risk stage only
  latencyMs: number; requestHash: string;
}

// ---- loop ----
export type StageName = 'replan' | 'intent' | 'context' | 'propose' | 'risk' | 'execute' | 'judge' | 'complete';
export type Intent = 'investigate' | 'edit' | 'verify' | 'fix_environment' | 'finish' | 'none_of_these';
export type StopReason =
  | 'complete' | 'max_steps' | 'spend_cap' | 'wall_time' | 'human_abort' | 'signal'
  | 'replan_stop' | 'generator_done' /* Jev-off only */ | 'error';
export interface StepRecord {
  step: number; startedAt: string; intent: Intent; contextFiles: string[];
  proposal: Proposal | null; risk: RiskAssessment | null; outcome: ActionOutcome | null;
  judge: JudgeResult | null; completion: number | null; decisions: Decision[];
  usage: StepUsage; timing: StepTiming; loopSignature?: string;
}
export interface RiskAssessment {
  dims: Record<'destructive' | 'out_of_scope' | 'plan_mismatch' | 'irreversible', { risk: number; confidence: number; level: number }>;
  risk: number; verdict: 'ok' | 'review' | 'block'; reason: string;
}
export interface JudgeResult { succeeded: number; errorPresent: number; testsPass: number | null; newInfo: number }
export interface StepUsage { generator: TokenUsage; jev: TokenUsage }
export interface TokenUsage { inputTokens: number; outputTokens: number; costUsd: number; calls: number }
export interface StepTiming { generatorMs: number; jevMs: number; execMs: number; harnessMs: number; totalMs: number }

// ---- provider ----
export interface GenerateRequest { system: string; messages: ChatMessage[]; maxTokens: number; temperature?: number }
export interface ChatMessage { role: 'user' | 'assistant'; content: string }
export interface GenerateResult { text: string; usage: TokenUsage; model: string; stopReason: string; latencyMs: number }
export interface Provider {
  readonly name: 'anthropic' | 'openrouter' | 'mock'; readonly model: string;
  generate(req: GenerateRequest, opts: { signal: AbortSignal; onDelta?: (text: string) => void }): Promise<GenerateResult>;
}
export interface Decider {
  readonly model: string;
  ask(state: Json, questions: Record<string, Question>, opts: { signal: AbortSignal; stage: StageName; step: number }): Promise<{ answers: Record<string, Answer>; usage: TokenUsage; latencyMs: number; model: string; requestHash: string }>;
}
export interface Confirmer { confirm(req: { step: number; proposal: Proposal; risk: RiskAssessment }): Promise<boolean> }
```

## 5. Jev integration

### 5.1 Client (`jev/client.ts`), ported from `lab.mjs`

Same wire protocol as `lab.mjs` lines 47-73 and 79-107: `POST {JEV_BASE_URL}` with
`Authorization: Bearer`, `Content-Type: application/json`, `HTTP-Referer`, `X-Title`, body
`{ model, state, questions }`, response `{ model, answers, usage, id, provider }`. Kept from
`lab.mjs`: header capture (`x-generation-id`, `retry-after`, `x-provider-name`), text-first
parsing, `redact()` over every error string, `sha()` request hashing, spend accounting after
every response with `usage`, `pmap` bounded concurrency. Changed: retry is jittered
(REPORT §12 SDK policy: 500 ms doubling to 5 s, 25 % jitter, honour `Retry-After` up to
60 s; retryable = network error, 408, 429, 5xx except 501) with 3 attempts; the spend cap
is a shared `SpendMeter` rather than a file in `/tmp`; the key comes from config, not a
hard-coded `.env` path; every response passes `validateJevResponse()` before use.

### 5.2 Validation (`jev/validate.ts`)

Hand-written validators (no schema library): status 200, JSON object, `answers` object with
exactly the requested ids, each answer's `type` equals the question's type, `noul` in
[0, 1], `probabilities` keys equal the option keys / level indices, values in [0, 1] and
summing to 1 ± 0.05, `choice` equals the argmax key, `score` within [0, n−1], `usage`
numbers finite. Failures raise `JevResponseError` with the offending path; the caller
retries once (a validation failure is not a network error) and then fails the stage.

### 5.3 Confidence and probability, computed in the harness (REPORT §8)

- Choice: `confidence = (p_max − 1/n) / (1 − 1/n)`; `probability = p_max`.
- Score: `confidence = 1 − Σ_k p_k·|k − k*| / U_n`, `k* = argmax`, `U_n = (n²−1)/(4n)` for
  odd n, `n/4` for even n; `probability = p_{k*}`.
- Noul: `probability = p`; the pane's confidence column shows `|2p − 1|` (Jev returns no
  confidence for Nouls; this derived value is labelled as such, §16).
- Risk per dimension: `E[k]/(n−1)` on a 5-level Score, so a fully confident level 0/1/2/3/4
  maps to 0/0.25/0.5/0.75/1.0; risk = max over the four dimensions. Reason: the prompt's
  0.3 / 0.7 bands then correspond to "level 2 dominant → review", "level 3+ dominant →
  block", and a split distribution (0.5 on level 0, 0.5 on level 4) lands in review, which
  is the right call for an uncertain judgment. Alternatives considered: `P(k ≥ 2)` (ignores
  how bad), max-probability level (throws away mass), Nouls per dimension (absolute but
  clipped to [0.01, 0.99] and not graded). Scores are rounded to two decimals on the wire,
  so `E[k]` carries ≤ 0.02 rounding error; thresholds are compared with `>=` on the
  computed value and the raw distribution is stored.

### 5.4 Question rules (REPORT §11, §14), enforced by `jev/questions.ts`

1. All questions for a stage go in one request (9.1× fewer tokens, 17× faster).
2. State is a JSON object; every instruction names its target with a backticked path
   (`` `proposal.action.command` ``), never "the command".
3. Every Choice has an escape option (`none_of_these: null`) and, where "none" is a
   meaningful outcome, a paired Noul.
4. Criteria are `{ definition, examples: { yes: [...], no: [...] } }` objects for Nouls
   and situation descriptions for Score levels; option keys are descriptive words, never
   `a`, `alpha`, `1`.
5. Jev never counts or computes: test counts, byte sizes, step counts, diff stats are
   computed in code and placed in the state as fields.
6. Thresholds are not placed at 0.5 on borderline questions: completion fires at ≥ 0.85
   by default; judge outcomes are reported as probabilities, not booleans.
7. Model id pinned to the dated id; the response's `model` is checked against it and a
   mismatch is a `JevResponseError` (drift protection).

### 5.5 Per-stage questions

State common to every stage (compact, code-built):

```json
{ "task": "<user task text>",
  "plan": { "done": [...], "remaining": [...], "openProblems": [...] },
  "recent": [ { "step": 6, "intent": "edit", "action": "edit src/a.py", "outcome": "executed", "judge": { "succeeded": 0.92 }, "output": "<≤600 chars>" } ],
  "workspace": { "root": "…", "git": true, "hasTests": true, "testCommand": "pytest -q", "changedFiles": ["src/a.py"] },
  "budget": { "stepsUsed": 6, "stepsMax": 40, "spentUsd": 0.31, "capUsd": 2 } }
```

**replan** (only after loop detection): Choice `next_move` over `change_approach`,
`gather_context`, `fix_environment`, `revert_changes`, `stop_and_report`, `none_of_these`,
each with a one-sentence description; state adds `loop: { signature, kind, occurrences,
lastOutcomes: [...] }`. Plus Noul `task_impossible` ("Is `task` impossible in this
workspace as stated?", criteria with examples).

**intent**: Choice `intent` over `investigate` ("read or search code before changing it"),
`edit` ("change source files"), `verify` ("run tests, a build, or a script to check the
current state"), `fix_environment` ("install a dependency or repair tooling so work can
continue"), `finish` ("nothing remains; the work is verified"), `none_of_these: null`.
Paired Nouls: `plan_still_valid` ("Does `plan.remaining` still describe what has to
happen next given `recent`?") and `needs_more_context` ("Would the engineer need to look
at code that is not in `recent` before acting?").

**context**: for `candidates[i]` (path, bytes, `mentionsInTask` computed by code,
`touchedThisRun`), one Noul per candidate: "Should `candidates[i].path` be shown to the
engineer for a `intent` step?" with criteria definition/examples once in the state under
`criteria.context` (state fields cost tokens once; the same instructions text is repeated
per question, which is ~9 tokens each). Selection in code: p ≥ 0.5, descending, cap 12
files and 60 KB; files the intent step must touch (from `plan.remaining[0]` mentions) are
candidates but not forced in. Candidates are pre-filtered in code to ≤ 300 paths by
mention count and recency, so the request stays under the 32 k state cap.

**risk** (after propose): state adds `proposal: { goal, action }` and `intent`. Four Scores,
five situation levels each (`criteria` arrays):

- `destructive`: 0 "reads, searches, lists, or runs tests/builds; changes nothing the
  workspace does not already regenerate", 1 "edits or creates files under version control
  inside the workspace; `git checkout` undoes it", 2 "deletes files, rewrites untracked
  files, or changes configuration/CI/dependency manifests", 3 "mass deletion, history
  rewrite, force push, or `rm -rf` inside the workspace", 4 "touches anything outside the
  workspace: home directory, system packages, other repos, credentials, running processes".
- `out_of_scope`: 0 "directly does what `plan.remaining[0]` or `task` asks", 1 "setup or
  investigation the task plainly needs", 2 "tangential improvement not asked for", 3
  "unrelated to `task`", 4 "contradicts an explicit constraint in `task`".
- `plan_mismatch`: 0 "matches `intent` and the plan", 1 "matches the plan, different order",
  2 "skips a planned verification step", 3 "ignores the plan's open problems", 4
  "contradicts the plan or repeats a step `recent` shows already failed the same way".
- `irreversible`: 0 "no lasting effect", 1 "reversible with one git command", 2
  "reversible with effort (regenerate, reinstall)", 3 "hard to reverse (network writes,
  emails, publishes, deletes outside git)", 4 "cannot be reversed".

Plus Noul `matches_intent` ("Does `proposal.action` carry out `intent`?") shown in the pane
and folded into `plan_mismatch`'s reason text, not into the risk number.

**judge** (after execute, batched with **complete**): state adds `executed: { action,
exitCode, timedOut, truncated, output: "<≤4 KB head+tail>", changedFiles, tests: {
command, parsed: { passed, failed, errors } | null } }`. Nouls: `succeeded` ("Does
`executed.output` show that `proposal.goal` was achieved?"), `error_present` ("Does
`executed.output` contain an error the engineer must fix?"), `tests_pass` (only when
`executed.tests` exists: "Does `executed.tests` show every test passing?" with the parsed
counts in the state), `new_information` ("Does `executed.output` contain information that
changes `plan.remaining`?"), and the completion Noul `task_complete`: "Is `task` complete?"
with criteria `{ true: { definition: "the requested behaviour is implemented AND verified
in this run by a passing test run or equivalent evidence", examples: [...] }, false: {
definition: "…untested, partially implemented, tests failing, or `plan.remaining`
non-empty for a good reason", examples: [...] } }`. When the workspace has tests the true
criteria say so explicitly ("tests exist; complete requires `executed.tests.parsed.failed`
to be 0 in the most recent run").

Stop rule: `task_complete ≥ completeThreshold` → `stopReason = 'complete'`. Budgets are
checked in code before every stage; the first that fires is recorded.

## 6. The step loop (`loop/engine.ts`)

```
resume or init run  →  render first frame  →  validate config on first use
loop:
  budgets? → stop(reason)
  if loopDetector.tripped(): replan Choice → directive (or stop)
  intent   : Jev Choice + Nouls (1 request)
  context  : Jev Nouls over candidates (1 request) → selected files, bounded read
  propose  : generator streams one JSON proposal; parse+validate (1 retry on malformed)
  risk     : Jev 4 Scores + Noul (1 request) → risk=max → ok | review(confirm) | block
  execute  : sandboxed action (or outcome=blocked/declined/failed)
  judge+complete : Jev Nouls (1 request) → plan update accepted if succeeded ≥ 0.5
  checkpoint (atomic) ; emit status ; loopDetector.observe(step)
  if complete ≥ threshold → stop('complete')
```

Three to four Jev round trips per step (~170 ms each, REPORT §5); generator latency
dominates. Independent work runs concurrently: the candidate listing and the plan/window
serialisation overlap the intent request; the checkpoint write overlaps the next step's
intent request (awaited before the next checkpoint and on shutdown).

**Plan** (`loop/plan.ts`): the generator returns a full `PlanDraft` each step; the harness
diffs it against the current `Plan`. Items newly in `done` are accepted only when this
step's `judge.succeeded ≥ 0.5`, and receive `evidence: { step, judged }`; otherwise they
stay in `remaining` and the rejection is noted in the next prompt. `openProblems` are
replaced verbatim. Size caps: 20 items per list, 200 chars each.

**Recent window** (`loop/window.ts`): last 4 steps, each ≤ 600 chars of output (head 400 +
tail 200) plus action summary, outcome, judge probabilities, blocked/declined reasons.
Context files: ≤ 12 files, ≤ 60 KB total, each ≤ 16 KB (head, with `…[truncated N
bytes]`). So the generator prompt is O(plan + window + context), never O(transcript).

**Loop detection** (`loop/loopdetect.ts`): per step compute a signature: `run:<sha12
(normalised command)>` for `run`, `patch:<sha12(path+old+new | diff | path+content)>` for
edits, and `fail:<sha12(normalised error lines)>` when the outcome failed or exit ≠ 0
(normalisation strips digits, paths' hashes, timestamps). A signature seen 3 times trips
the detector; the next step starts with **replan**; the chosen directive is injected into
the generator prompt and stored in `plan.openProblems`; the counter for that signature
resets. `stop_and_report` → `stopReason = 'replan_stop'`.

**Risk policy**: `risk ≥ 0.7` → `blocked`, reason built from the dimension(s) at the max
with the dominant level's text and the Jev confidence; returned to the generator in the
window. `0.3 ≤ risk < 0.7` → `Confirmer.confirm()`; the TUI renders the prompt inline and
the loop awaits it; there is no auto-approve; the bench confirmer always returns `false`
and the outcome is `declined`, counted as blocked in bench metrics. `risk < 0.3` →
execute. A `done` proposal is never executed; it is a signal that feeds the completion
Noul via `recent`.

**Budgets** (`loop/budget.ts`): `SpendMeter` sums Jev `usage.cost` and generator cost (from
the provider's `usage.cost` on OpenRouter, from the pricing table on Anthropic). After each
priced call `meter.add()` checks the cap and throws `BudgetError('spend_cap')`; the engine
catches it at the stage boundary, records the partial step, checkpoints, and stops. Max
steps and wall time are checked before each stage.

## 7. Generator (`provider/*`)

`Provider.generate()` streams. `anthropic.ts` speaks the Messages API over SSE
(`message_start`, `content_block_delta` text deltas, `message_delta` usage) `[R]`;
`openrouter.ts` speaks chat completions with `stream: true` and `usage: { include: true }`
so the last chunk carries `usage.cost` `[R]`. `sse.ts` is a small shared parser over
`res.body` (WebStreams). Both map errors to `ProviderError { status, code, retryable }`
and use the same jittered retry as Jev. Responses are validated (`choices[0]`, `usage`
numbers) before use.

**Prompt** (`provider/prompts.ts`): a fixed system prompt (role, one-action rule, the JSON
schema, edit-format rules: `old` must be copied verbatim and match exactly once; prefer
`edit` for changes under ~60 lines, `write` for new files, `patch` only when given a diff;
`run` commands are non-interactive and must finish inside the timeout) and one user
message per step: task, plan, Jev's intent with its probability, blocked/declined reasons
from the window, replan directive if any, context files, recent window, and the
instruction to reply with one fenced ```json block:

```json
{ "goal": "one sentence", "action": { "kind": "edit", "path": "…", "old": "…", "new": "…" },
  "plan": { "done": [...], "remaining": [...], "openProblems": [...] } }
```

The system prompt is cache-marked on Anthropic (`cache_control: ephemeral`) `[R]`.
`actions.ts` extracts the last fenced JSON block, parses, validates against the `Action`
union with exact key checks, and raises `GeneratorResponseError` with a precise reason
that is fed back once ("malformed generator response" test).

Edit format choice `[R]`: exact search/replace with uniqueness (the Claude Code / Anthropic
text-editor convention) is the primary format because it is the most reliable for Claude
models and gives a crisp `EditError` (`no match` / `N matches`) for the loop detector;
unified diff is supported for completeness and is what the bench's mocked provider uses to
replay gold patches, which exercises the "patch fails to apply" path.

## 8. Sandbox and workspace

`sandbox/run.ts`: `spawn('/bin/sh', ['-c', command], { cwd: workspace, detached: true,
stdio: ['ignore', 'pipe', 'pipe'], env: scrubbed })`. `detached` makes the child a process
group leader so `process.kill(-pid, 'SIGTERM')` then `SIGKILL` after 2 s kills the whole
tree on timeout, output cap, cancel, or SIGINT. Env is rebuilt from an allowlist (`PATH`,
`LANG`, `TERM`, `TMPDIR` → run tmp, `HOME` → `<run>/home`) so no API key reaches a
subprocess. stdout/stderr are read as streams with a byte counter; at `maxOutputBytes`
(default 200 KB) the child is killed and `truncated: true` is recorded with head+tail kept.
Default timeout 120 s, per-action override capped at 600 s.

`sandbox/seatbelt.ts` `[R]`: on darwin, when `sandbox-exec` exists and `--sandbox` is
`auto`/`seatbelt`, the command runs under a generated profile: `(deny default)` is too
restrictive for toolchains, so the profile is `(allow default)` with `(deny file-write*)`
followed by `(allow file-write* (subpath <workspace>) (subpath <run tmp>) (subpath <run
home>) (subpath "/dev") (literal "/dev/null") …)`, plus `(deny network*)` when
`--no-network` is set. This is the same mechanism Codex CLI, Gemini CLI and Claude Code use
on macOS; its limits (deprecated API, no Linux) are documented in the README. Where it is
unavailable the guarantee degrades to cwd + env scrubbing + timeout + output cap + tree
kill, and `jevcode config` prints which level is active.

`sandbox/paths.ts`: every file action path is resolved against the workspace, its nearest
existing ancestor is `realpath`ed, and the result must start with `realpath(workspace) +
sep`; symlinks pointing outside, `.git/**` writes, and absolute paths outside are rejected
with `PathEscapeError` before anything touches disk.

`workspace/edit.ts`: exact match must occur exactly once (`EditError` otherwise); writes
are atomic (`atomic.ts`: write `path.tmp-<pid>-<rand>` then `rename`). `workspace/patch.ts`:
a pure-TypeScript unified-diff applier (hunk parsing, context matching at the stated line
with ±N line fuzz search, no fuzz on content), all-or-nothing per patch, `PatchError` with
the failing hunk. `workspace/tests.ts`: detects a test command (pytest, `npm test`, cargo,
go test) from manifests and parses pytest/jest/cargo summaries into counts for the judge
state. `workspace/candidates.ts`: `git ls-files` when the workspace is a repo, else a walk
with an ignore list; drops binaries and files > 1 MB.

## 9. Checkpoints and resume (`checkpoint/*`)

`~/.jevcode/runs/<run-id>/`:

| File | Content | Written |
| --- | --- | --- |
| `run.json` | task, workspace, masked config, versions, createdAt | once |
| `state.json` | `{ version, checksum, state: { step, plan, window, loopDetector, spend, stopReason, ... } }` | atomically every step, previous copy kept as `state.prev.json` |
| `steps.jsonl` | one `StepRecord` per line | appended every step |
| `decisions.jsonl` | one `Decision` per Jev question, with the request hash, usage and latency | appended per Jev call |
| `generator.jsonl` | prompt hash, token usage, latency, model per generator call | appended per call |
| `transcript.log` | the plain-text transcript | appended |

Everything passes through `redact()` before serialisation. `--resume <run-id>` loads
`state.json`, verifies the SHA-256 checksum and `version`; on failure it tries
`state.prev.json` (warning in the transcript); if both fail it throws `CheckpointError`
naming the run dir (exit code 3). The workspace is the real directory, so file state
persists across resume; the step counter, plan, window, spend and loop detector continue.

## 10. TUI (`tui/*`)

One Ink `render()` of `<App>`: a transcript pane (`<Static>` for committed items so Ink
never re-renders old rows; the live generator stream is one mutable row under it), a
decisions pane (last 12 `Decision`s: stage, id, answer, probability, confidence; `review`
rows yellow, `block` rows red, `ok` dim), a status line (step/max, wall time, tokens
generator/Jev, cost generator/Jev over cap, current stage, spinner), and an inline
confirmation box (`[y] approve  [n] decline`) rendered when a `confirm:request` event is
pending; `useInput` resolves it. UI state comes from a reducer fed by `EngineEvents`;
generator deltas are accumulated in a ref and flushed at ≤ 20 fps so rendering never
blocks the loop. `render({ exitOnCtrlC: false, patchConsole: false })`; Ctrl-C goes to the
engine's abort path. When `process.stdout.isTTY` is false (or `--plain`) `tui/plain.ts`
subscribes to the same events and prints one line per event
(`[step 3] intent=edit p=0.82 c=0.71`); confirmation reads `y/n` from stdin via
`readline` when stdin is a TTY, otherwise declines.

## 11. Errors and shutdown

`errors.ts`: `JevCodeError` (base, `code`, `exitCode`, `cause`) → `ConfigError`,
`JevError` (`JevHttpError`, `JevResponseError`), `ProviderError` (`ProviderHttpError`,
`GeneratorResponseError`), `SandboxError` (`CommandTimeoutError`, `OutputCapError`),
`PathEscapeError`, `EditError`, `PatchError`, `BudgetError(reason)`, `CheckpointError`,
`AbortError`. `process.on('unhandledRejection'|'uncaughtException')` route to a single
`fatal()` that redacts, writes the checkpoint if an engine exists, unmounts the TUI and
exits with the error's code. `SIGINT`/`SIGTERM` → `engine.abort('signal')` → kill sandbox
group → await checkpoint → exit 130; a second SIGINT within 2 s force-exits.

## 12. Performance plan

Budgets: first frame < 300 ms with zero network at launch; harness overhead < 50 ms per
step; rendering never blocks the loop.

- Launch: `bin/jevcode.js` calls `module.enableCompileCache()` `[R]` and imports one
  esbuild-bundled ESM file (`dist/jevcode.mjs`, ink+react bundled) `[R]`; `run` renders
  the App before reading config or the workspace; `bench`, `perf`, providers and the Jev
  client are dynamic imports.
- `perf/first-frame.ts` spawns `script -q /dev/null node bin/jevcode.js run --task x
  --workspace <tmp> --perf-exit-after-first-frame` (a pseudo-TTY) and measures spawn → first
  stdout byte; repeated 10×, reports median and p95, asserts no network via a fetch
  interceptor flag (`JEVCODE_ASSERT_NO_NETWORK=1` makes any fetch before first frame throw).
- `perf/step-overhead.ts` runs the engine in-process with `MockProvider` and `MockJev` at
  zero latency for 50 steps and reports `harnessMs` per step (total minus provider, Jev,
  exec time as measured by the engine's timers).
- `perf/render-lag.ts` runs a mocked run under the TUI in a pseudo-TTY with a 10 ms
  `setInterval` lag probe in the engine process and reports max/p95 event-loop lag.
- `perf/jev-latency.ts` (`--live`) measures raw/p50/p95 for representative stage requests.
- `npm run perf` writes `perf/results/latest.json` and prints a table; the README carries
  the numbers.

## 13. Bench (`bench/*`)

`jevcode bench --suite swebench|terminal-bench|all --tasks N|--task <id>,… --conditions
jev-on,jev-off --concurrency 3 [--live --spend-cap USD] --out bench/results/<id>`.

- **Tasks**: `bench/data/swebench-verified-30.json` holds 30 instance records (`instance_id`,
  `repo`, `base_commit`, `environment_setup_commit`, `version`, `problem_statement`,
  `hints_text`, `FAIL_TO_PASS`, `PASS_TO_PASS`, `test_patch`, `difficulty`, plus the
  harness spec's `install`, `pre_install`, `test_cmd`, `python`) taken from the dataset
  and the `swebench` constants `[R]`; gold `patch` lives in a separate file used only by the
  mocked provider. Terminal-Bench task dirs (instruction, `task.toml`/`task.yaml`, `tests/`)
  are checked in under `bench/data/terminal-bench/` for the chosen subset `[R]`.
- **Conditions**: `jev-on` = the full engine; `jev-off` = `loop/generator-only.ts`: the
  same provider, prompt, sandbox and budgets, but the generator picks its own actions, sees
  files it asks for, nothing is risk-scored or judged, and it stops when it says `done`.
- **Per task record** (`tasks.jsonl`): `task`, `condition`, `pass` (`true|false|null`),
  `evaluator` (`local-venv|docker|local|mock|none`), `steps`, `wallMs`, `tokensPerStep`
  (array), `cost: { generator, jev }`, `jevLatencyMs: { raw: [], p50, p95 }`, `timing: {
  generatorMs, jevMs, execMs, harnessMs }`, `stopReason`, `blocked`, `reviews`, `loops`,
  `runId`.
- **Outputs**: `tasks.jsonl`, `summary.json` (per condition: pass rate, mean/median steps,
  mean tokens/step, cost, Jev latency percentiles, stop-reason histogram), `comparison.md`
  (tables, steps-to-solve distribution and tokens-per-step-by-step-index curves as
  markdown tables with inline bar characters), and `predictions.jsonl` in the official
  SWE-bench shape for external evaluation.
- **Mocked** (default): `MockProvider` replays a trajectory derived from the gold patch
  (read touched files → apply patch → run tests → done) and `MockJev` answers from
  deterministic rules; the evaluator is `mock` (pass iff the gold patch applied). This
  exercises the whole pipeline offline.
- **Live**: `--live` requires a spend cap; evaluation uses the local-venv evaluator for
  SWE-bench (clone at `base_commit`, `python3 -m venv`, run `install`, apply `test_patch`,
  run `test_cmd` on `FAIL_TO_PASS` and `PASS_TO_PASS`, pass iff all pass) and the local
  runner for Terminal-Bench; Docker is unavailable here (DECISIONS.md).

## 14. Testing

`vitest` with two projects: `unit` (offline, mocked `fetch`, temp workspaces) and `live`
(`test:live`, hits Jev and the generator, skips with a reason when a key is missing).
Required explicit tests: patch fails to apply; output cap hit; command timeout; Ctrl-C
mid-command (SIGINT to the engine kills the process group and writes the checkpoint);
spend cap hit mid-step; malformed Jev response; malformed generator response; review
answered no; corrupt checkpoint on resume. Plus: config precedence and masking, retry
with jitter and `Retry-After`, redaction, confidence formulas against REPORT §8 numbers,
risk mapping, loop detection and replan, plan evidence rules, window bounds, SSE parsing
for both providers from fixtures, path escapes and symlinks, atomic writes, TUI frames with
`ink-testing-library` (decisions highlighting, confirmation), plain renderer, CLI parsing,
bench mocked end to end on 3 tasks.

## 15. Dependencies

Runtime: `ink`, `react` (Ink's peer). Dev: `typescript`, `@types/react`, `@types/node`,
`vitest`, `ink-testing-library`, `esbuild`, `tsx`. Everything else is Node built-ins
(`node:util` `parseArgs`/`parseEnv`/`styleText`, `fetch`, WebStreams, `node:crypto`,
`node:child_process`, `node:fs/promises`, `node:readline`). Each is justified in the README.

## 16. Deviations from the prompt and from REPORT.md

1. **Noul "confidence"** in the decisions pane is the derived `|2p − 1|`, because Jev
   returns no confidence for Nouls (REPORT §1); the pane labels it "derived".
2. **Risk as expected level** (`E[k]/(n−1)`) rather than a raw Score: the prompt says
   "scores it … with risk as the max"; a Score's `score` field is `Σ k·p_k` on a 0..n−1
   scale (REPORT §1), so normalising by `n−1` is the direct reading; §5.3 records why.
3. **Completion uses a Noul threshold at 0.85**, not 0.5, per REPORT §14's advice against
   thresholds at 0.5; configurable.
4. **Default provider `anthropic` cannot be exercised live** in this build (no key);
   OpenRouter is used for every live run (DECISIONS.md).
5. **Bench evaluation without Docker** (DECISIONS.md): `pass` comes from a local venv
   evaluator / local Terminal-Bench runner and the evaluator is recorded per task; the
   official prediction format is also emitted.
6. **Retry policy** follows the TypeSafe SDK defaults (jittered, REPORT §12) rather than
   `lab.mjs`'s un-jittered `400·2^(n−1)`, because the prompt asks for jittered backoff.
7. **Context Nouls repeat the instruction text per candidate** rather than putting a
   single instruction in the state; REPORT §7 shows ids are invisible to the model, so each
   question must name its own path.
8. **The Jev spend cap is shared with the generator** in one `SpendMeter` (the prompt asks
   for one spend cap); `lab.mjs` capped Jev alone via a file.

## 17. Open questions

- Whether the checked-in SWE-bench subset can be evaluated locally for every chosen repo
  under Python 3.9 (to be measured in the 3-task slice).
- Whether Terminal-Bench tasks beyond a few shell-only ones are runnable without Docker.
- Prompt caching effect on tokens/step through OpenRouter (measured in the bench).
