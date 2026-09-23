# The LLM loop on the new harness — `jev-on-next`: routers, the sieve fast path, and the S2 generator path

**Status:** normative design, ratified from three competing designs and two independent judgements (2026-09-22).
**Winner:** *Fastlane S2/S4 — the sieve as a step the loop can take*, with twelve grafts from design 1 (*Route-first
jev-on*) and design 3 (*week-1 cut first*) and two factual corrections carried in from verification.
**Scope:** harness only. `src/loop/**`, `src/synth/**`, `src/jev/**`, `src/provider/**`, `src/bench/**`,
`src/core/types.ts` (additive members inside the existing contract blocks), `src/core/limits.ts` (additive),
`experiments/**`, `docs/**`, `scripts/jev-contract.mjs`, `test/**`.
**Never touched:** `src/tui`, `src/cli`, `src/config`, `src/session`, `src/chat`.

Every line number in this document was read off `main` at **`d86c385`** (post-`oos-iter-2`) on 2026-09-22,
and re-verified after merging that `main`. Where an earlier document's
number has drifted, the correction is called out at the site; a patch written to the old number lands in the
wrong place.

---

## §0 Contract and invariants

### 0.1 The request this answers

> *"use the llm for the main loop if not already done with the new harness"*

The LLM already drives the loop and has since 2026-09-22: `DEFAULT_MODE = 'llm-jev'` (`src/config/defaults.ts:50`).
Two distinct things are called "the LLM in the loop" and they must not be confused:

- **`llm-jev`** — the LLM is a *candidate source inside the synthesizer*. The engine calls
  `runSynthStage(ctx, synthesizer, sctx)` (`src/loop/engine.ts:3894`) and the generator's samples are one of four
  candidate sources the sieve tests.
- **`jev-on`** — the LLM *proposes each step directly* through `propose_action`
  (`src/loop/engine.ts:3906`, the final `else` of the propose dispatch).

Nothing needs flipping to "use the LLM for the main loop". What is missing is that **`jev-on` is slow and
unaccelerated**: none of the Fastlane work (S0, S1) reaches it, S2 was written against two non-default modes, and
Jev still *gates* three things in `jev-on` that it does not gate in `llm-jev`. This design makes `jev-on` the
primary LLM loop on the new harness and gives it the three levers the measurement says exist.

**The default-mode flip is NOT decided here.** It is a later decision, made on the numbers of §8.

### 0.2 The three additions

1. **S2 — the generator step gets faster.** Hedged samples, a byte-stable prompt prefix, a TTFB callback, a
   reasoning cap, `--quick`. This is `jev-on`'s own prompt, which after this design is the primary path — which
   answers the standing objection that S2 optimised two non-default modes.
2. **S4 — Jev's asks become speculative routers.** `routeSpeculative`, `ROUTER_DEADLINE_MS`, the landed
   exact-digest cache in `src/jev/cache.ts`. Jev routes; it never gates.
3. **The fast path (route R9).** On the one shape the search provably wins — a single-file failing cluster whose
   whole candidate pool is testable inside one SIEVE round at the measured `t_run` — the loop stops asking the
   generator to guess and instead runs **one bounded sieve round** and proposes its cold-confirmed passer.

The fast path is **a branch route in the same table as the others** (graft, judge 2 §2): it inherits the deadline
discipline, the drop semantics and the record row of a router rather than inventing a parallel mechanism, and one
invariant (`routerWaitMs === 0`) covers the whole table.

### 0.3 The switches

Two new `EngineOptions` members. Both are real options with env overrides, both default **off** on `main`
(graft, judge 1 §1). No `src/config` and no `src/cli` change is needed: the engine derives the default from the
mode, and the env overrides are read inside `src/loop`, exactly as `JEVCODE_WARM` is read in `src/synth/warm/plane.ts:30`.

| option | type | default on `main` | default in the bench arm | env override |
|---|---|---|---|---|
| `fastPath` | `'auto' \| 'off'` | `'auto'` when `mode === 'jev-on'`, `'off'` in every other mode | `'auto'` | `JEVCODE_FASTPATH=off\|auto` |
| `routers` | `'on' \| 'off'` | **`'off'`** in every mode | `'on'` (**`jev-on` only**) | `JEVCODE_ROUTERS=on\|off` |

`routers` defaults **off on main** deliberately. The router wave carries three polarity changes — the risk
verdict, the replan stop, and completion — and none of them may reach a user run before the head-to-head of §8
decides. `fastPath` defaults `auto` in `jev-on` because it is purely additive: it can only propose, and it
degrades to "the LLM proposes as usual".

**The `routers` switch is gated on `mode === 'jev-on'`, first and unconditionally** (as built; review
2026-09-22, defect 4). `runReplanStage` is the ONE replan site for every mode — unlike judge, which branches to
`runCodeJudgeStage` for `llm-jev`, and risk, which branches to `runHarmOnlyRiskStage` — so a switch read only
from the environment demoted `stop_and_report` and `task_impossible` in `llm-jev`, `jev-only` and `jev-off` as
well: the control arms §8 exists to measure `jev-on` against. `routersOn(mode, opt?)` in `src/loop/routers.ts`
returns false for every other mode before it reads the option or the env var.

**`EngineOptions.routers` is read, and it BEATS the env var** (as built at `c811899`, §7.5a; review 2026-09-22
defect 3, then slot D's finding). `makeContext` puts it on `StageContext.routers` and the four routed sites call
`routersOn(ctx.mode, ctx.routers)`. `JEVCODE_ROUTERS=on|off` fills an **absent** option only — it used to be ORed
in, so an exported `on` armed an arm whose own `summary.json` row said `off`. `JEVCODE_FASTPATH` was inverted the
same way in the same commit. The `jev-on` gate is checked before either.

**No new `EngineMode`.** `jev-on-next` is a *bench condition*, not a mode. `MODES` is untouched.

### 0.4 Invariants

**I1 — Jev routes, never gates.** After this wave no Jev answer on the loop can end a run, block an action, or
withhold a candidate. A full Jev outage in `jev-on-next` costs ordering quality and `routerWaitMs` 0; it costs no
step and no run. This is the fix for the recorded outage that killed `sympy-17139`, `django-15128` and
`django-15315` in three dead runs.

**I2 — byte identity when off.** A run with `fastPath: 'off'` **and** `routers: 'off'` is byte-identical to
today's `jev-on`: the same assembled prompt bytes under `view: 'legacy'`, the same Jev state bytes, the same
event order, the same `steps.jsonl` (absent optional members serialise as absent). The new code is entered from
exactly **three** `if` statements — one in the propose dispatch, one in `askRecorded`, one in `completeAfter` —
all false. Asserted by a golden in **both** slot B's and slot C's test files, on the existing `jev-on` fixtures.

**I3 — `routerWaitMs === 0`.** A router contributes zero blocked wall to the step. `jevMs` may grow (the request
is still made, still metered, still recorded); `routerWaitMs` must read 0. This is asserted per routed site by a
unit test *and* as a bench-wide blocking row. It is easy to break silently later with nothing but latency as the
symptom, so it is **measured, never written** (§2.1). As built at `c811899` it is also asserted on a REAL step:
`commitStepRouters` folds the ledger into `StepTiming.routerWaitMs` at step commit, and
`test/unit/loop/engine-router-seam.test.ts` reads it off a committed `StepRecord` rather than off a hand-built
ledger. The bench-wide row is still owed (slot D).

**I4 — no late write.** Every router result is applied through a **step-scoped token invalidated at step commit**
(graft, judge 1 §5). An in-flight ask that outlives its step can never write to a committed `StepRecord` or to a
superseded draft; a late answer is recorded as `dropped`, never applied. `routeSpeculative` introduces concurrency
into a loop that has been strictly sequential, and this is the invariant that makes that safe.

**I5 — router failures are not stage failures.** A router timeout, a `JevError`, a 503/529 or an abort must not
increment `consecutiveStageFailures` (`engine.ts:5039`, `:5063`; `CONSECUTIVE_STAGE_FAILURE_LIMIT = 3` at
`engine.ts:299`). Today three Jev 503s end the run — that is the exact failure the head-to-head already recorded.
Excluding router failures from the counter is the single change that makes I1 true.

**I6 — zero generator calls where promised.** The fast path constructs its synthesizer with `mode: 'jev-only'`,
so it makes **zero** generator calls and spends **zero** generator tokens. The `jev-only` condition's
zero-generator-calls invariant stays trivially true (that condition never enters the fast path — `fastPath` is
`off` outside `jev-on`). `jev-only` and `llm-jev` are untouched by this wave.

**I7 — the fast path proposes; it never applies.** An accepted fast-path result becomes `draft.proposal` at the
normal place and goes through the **unchanged** risk → confirm → coordinate → budget → execute → judge path.
It never executes, never commits, never bypasses risk.

**I8 — the warm plane stays off.** Every number in §8 is a `JEVCODE_WARM=off` number, and the fast path's budget
is sized for cold lanes. Standing decision `9f58e0c` keeps the plane off until a real-lane test **and** Ring 1
pass with it on; at `751e3bf` `llm-jev` never completed a synthesis step with it on (lanes ran nothing, 0 % CPU
for 59 minutes). A fast-path speedup quietly measured with warm on is not a number about any run that happens
today.

**I9 — the contract is additive.** Contract 1.9 adds optional members inside the existing blocks and widens two
unions. `CheckpointEnvelope.version` stays 1. Nothing is required, nothing is renamed, `Action`,
`STOP_REASON_SET`, `exitCodeFor` and `MODES` are untouched.

**I10 — no new `EngineEvent` union member.** (graft, judge 1 §9.) The `synth` event's `phase` is already
`phase: string` (`src/core/types.ts:1833`, verified), so `fastpath:*` and `router:*` ride it. Both TUI consumers
(`src/tui/useEngine.tsx:855`, `src/tui/plain.ts:708`) do have `default:` clauses, so new members *would* be
runtime-safe — but reusing an existing type leaves the event union, the checkpoint replay and the plain renderer
entirely untouched, which is the smaller blast radius and keeps a forbidden directory out of the diff by
construction rather than by argument.

**I11 — the ratchet is two-sided.** Every converted site gains a real four-clause block *and* **loses** its
allow-list row in `scripts/jev-contract.mjs`. The lint counts un-annotated sites per file and fails when a row
grandfathers more than the file has (`scripts/jev-contract.mjs:244`), so a converted row must be tightened or
dropped in the same commit.

### 0.5 Two corrections carried in from verification

**C1 — `testWallLeftMs` does bound a long batch.** Two of the three designs justified their abort belt with
"`testWallLeftMs` is only written at batch end (`runner.ts:1039`), so it cannot bound a long batch". That is
**false**. `wallLeft()` (`src/synth/sieve/runner.ts:661`) is a live closure over `wallAtStart` and `batchStart`
and it bounds dispatch at `:679`, the per-run cap at `:730`, the streaming park at `:960` and the retry loop at
`:1017`. Keep the `AbortSignal` ceiling, but justify it as **defence in depth**, not as the only intra-batch
bound.

**C2 — `deps.rank` line drift.** `docs/HARNESS-NEXT-DESIGN.md` cites the `deps.rank` sites at `:848` / `:1575`;
on current `main` they are **`src/synth/search/subgoal.ts:864` and `:1617`**.

---

## §1 The loop as built today

### 1.1 The propose dispatch

`src/loop/engine.ts:3870–3907` is the whole of it:

- `replayed !== null` → the replayed proposal (M15 replay).
- `mode === 'jev-only' || llmJev` → the `Synthesizer`. If `llmJev && !synthesizerHandles()` the step falls back
  per step to the generic `propose_action` sample with `draft.proposer = 'generic'`; otherwise
  `draft.proposer = 'synth'` and `runSynthStage(ctx, synthesizer, sctx)` runs, with `draft.synthMs`,
  `draft.synthJevMs` and `draft.synthJevWallMs` recorded in a `finally`.
- **else** → `this.proposeWithContext(ctx, draft, changedFiles, contextFiles, null)`. This is `jev-on`. This is
  the branch the fast path guards.

`this.synthesizer` is `init.opts.synthesizer ?? null`. **`src/cli/session.ts` builds one only for
`jev-only | llm-jev`**, and `src/cli` is outside this owner split — which is the single fact that decides §4.2.

### 1.2 Where Jev can stop or block a `jev-on` run today

| # | site | what it decides today | file:line |
|---|---|---|---|
| 1 | risk Q19/Q20 | the verdict; a failed ask means ask-or-decline | `src/loop/stages/risk.ts:688`, `:741` |
| 2 | completion Q22 `task_complete` | consumed in `jev-on` (recorded-only in `llm-jev`) | built at `src/loop/stages/complete.ts:16`, **decided at `src/loop/engine.ts:4514` `completeAfter`**, read at `:4091`, `:5117`, `:5268` |
| 3 | replan Q18 `next_move` | `stop_and_report` ends the run | `src/loop/stages/replan.ts:215` |

**Correction to two of the three designs (graft, judge 1 §4):** the completion change lives in
`Engine.completeAfter` at `engine.ts:4514`, **not** in `src/loop/stages/complete.ts`. `complete.ts` only builds
the question and holds the pure `isCompleteByFact` predicate (`complete.ts:243`, verified). A slot that claims to
demote completion without editing `engine.ts` has not demoted completion.

Any Jev throw in intent / context / risk / judge / replan today falls to `handleStepError`'s stage-failure branch
(`engine.ts:5058`) and three in a row return `{ stop: 'error' }` (`engine.ts:299`, `:4094`).

### 1.3 The five loop asks

| ask | file:line | shape | code fallback that already exists |
|---|---|---|---|
| Q7 intent Choice | `src/loop/stages/intent.ts:195` | `resolveChoice<Intent>` with `escape: 'none_of_these'` | `INTENT_FALLBACK = 'investigate'` |
| Q2–Q6 context Nouls | `src/loop/stages/context.ts:94` | ordering only | the code pre-filter (mention count, then recency) |
| risk Q19/Q20 | `src/loop/stages/risk.ts:688` | Scores + `matches_intent` / `evidence_consistent` Nouls | `codeRiskReason()` at `risk.ts:364` — **an allow-list of safe cases**, returns `null` for an arbitrary `run` |
| judge Q19/Q21/Q22 | `src/loop/stages/judge.ts:226`, `:261`, `:283` | outcome + completion | the harness's own parsed test counts |
| Q18 replan | `src/loop/stages/replan.ts:215` | `resolveChoice<ReplanOption>` | `REPLAN_FALLBACK = 'change_approach'`; `task_impossible` is already not asked on the synth path (`replan.ts:213`) |

Every one of these is **awaited inline** through `askRecorded` (`engine.ts:2847`), so today each contributes its
full latency to `jevWaitMs`. Measured Jev latency: p50 237 ms, p95 547 ms.

### 1.4 The contract lint's grandfathering

`scripts/jev-contract.mjs` allow-lists 22 files. Five of them are the loop stages above
(`intent.ts` 1 site, `context.ts` 1, `risk.ts` 2, `judge.ts` 3, `replan.ts` 1 = **8 sites**). The consequence
today is that **no loop stage has a lint-checked throwing-`Decider` test** — clause 3 ("a fallback naming its own
test") is asserted in prose in the allow-list `why` and nowhere in code. Slot B closes that.

### 1.5 The synthesizer's step lifecycle (what the fast path must not re-implement)

`LedgerSieveSynthesizer.synthesize()` → `step()` (`src/synth/search/index.ts:679`) → `rebaseline()`
(`:1244`, **private**). `rebaseline` is where the step becomes possible at all: it installs `mem.oracle`
(`fitOracle` at `:1261`), `mem.stepBudget` (`freshBudget` at `:1262`), `mem.bases`, `mem.tried`,
`mem.passersThisStep` and the ledger/window protocol.

A caller entering *below* that — at the exported `searchSubGoal` — gets a fresh `createMemory` carrying
`emptyStepBudget()` (`src/synth/search/memory.ts:164`), whose `exhausted: () => true`. The round returns an
instant `{ kind: 'budget' }` **indistinguishable from an honest decline**. That is precisely the failure that
would make the bench attribute nothing to the fast path while it tested nothing. **The fast path therefore calls
the public `synthesize()`.**

### 1.6 The budget arithmetic (and why the two obvious shortcuts are wrong)

- `freshBudget(limits, oracle, wallRemainingMs, opts)` — `src/synth/search/budget.ts:796`. Line `:798`:
  `const wallRemaining = Number.isFinite(wallRemainingMs) ? Math.max(0, Math.min(wallRemainingMs, limits.maxWallMs)) : limits.maxWallMs;`
  It derives the entire `StepBudget` — test runs, test wall, lanes, Jev requests, LLM rounds — from that number.
- `wallRemaining(ctx, scratch)` — `src/synth/search/index.ts:667`:
  `Math.max(0, ctx.limits.maxWallMs - (this.deps.now() - scratch.startedMs))`.
- `oracleClass(oracle)` — `budget.ts:648`. `quixbugs_class` = goal-subset < 2 000 ms **and** full suite < 10 000 ms.
- `poolFitsRunBudget(n, left)` — `budget.ts:222`, `n <= left`. This is the **entire** SIEVE cut as of the OOS
  2026-09-22 ranked change 1 (`budget.ts:946`, `:955`).
- `runsLeft(oracle, budget)` — `budget.ts:911`.

**Rejected shortcut A — shrink `limits.maxWallMs`.** `maxWallMs` is a **duration**, and it is read in at least
two other places: `budget.ts:596` feeds it to `fitOracle` as `wallRemainingMs`, and `index.ts:667` computes
`wallRemaining` from it. Shrinking it distorts oracle fitting and therefore `runTimeout`, and it also feeds
`commandTimeoutMs` decisions downstream.

**Rejected shortcut B — `maxWallMs: startedMs + elapsed + budgetMs`.** This is a **units error**: it writes an
epoch-scale value (~1.7e12) into a duration. `freshBudget`'s `Math.min` clamp becomes a no-op, `testRunsLeft`
stays at the class maximum, and the round fails **open** — bounded only by the abort belt, mid-batch, which is
exactly the wasted wall the fast path exists to avoid and exactly what would poison the wall column §8 measures.

**The adopted mechanism** is an explicit `ControllerOptions.fastPath` member and a ~6-line clamp inside
`LedgerSieveSynthesizer.freshBudget` (§4.3). `ControllerOptions` today has two members (`llmJev`, `generation`)
at `src/synth/search/index.ts:163`; the addition is inside that block.

### 1.7 The measured regimes

From `docs/research/llm-jev/oos-analysis-2026-09-22.md` and `experiments/results/llm-jev-iter1.md`:

| regime | `t_run` | pool vs budget | who wins |
|---|---|---|---|
| QuixBugs one-line | 230–520 ms | fits | search; passers were mutation 19 / template 6 / donor 0 / **LLM 0** |
| ladder multi-hunk (long-2) | small | fits | `llm-jev` 4/6 vs tuned generator 0/6 |
| SWE repository (`sympy-16792`) | 1 574 ms | **28 878 enumerated, 1 191 testable** — 24× over | nobody; 178 sieve requests ordering a pool 24× its budget |

`llm-jev` 12/18 vs tuned 9/18 on the fresh slice (b = 4 / c = 1, sign p = 0.19), QuixBugs 8/8 both, but **`llm-jev`
is 1.32× slower on the 8 both-solved tasks (26.0 s vs 19.7 s)** at a fifth of the cost. That slowdown is the exact
shape a losing fast path would deepen, and §8 pre-registers against it.

### 1.8 Known defects this design must live with

- **Ring 1 `--jev off`: a code fix has landed but is UNMEASURED.** Ring 1 was red at iteration 1 (`gcd`,
  `mergesort` and `units` lost; the localiser returned `sitesConsidered: 0` — with every Choice escaped,
  `choiceProbs` dropped the escape and left every other option at probability 0, so the site list came back
  empty and the step parked with "no site located"). `oos-iter-2` landed the fix at **`0d61eef`** (*"an escaped
  Choice falls through to the code order, not to no site at all"*, with
  `test/unit/synth/localize/jev-off-fallback.test.ts`). **But `docs/DECISIONS.md` still records the iteration-1
  verdict, and iteration 2's own decision text says it "is measured on the same 18 + 28 before any of it is
  called an improvement" — so the gate is fixed in code and not yet green in measurement.** The fast path
  routes through that same localiser, so with Jev off a still-broken localiser would make it arm, enumerate
  nothing and spend its budget — a failure that looks exactly like an honest decline. §7.7 therefore keeps Ring
  1 green under `--jev off` as a **hard merge gate on both B and C**; what changed is that the gate is now a
  *re-measurement*, not a fix slot B must write.
- ~~**`runFactsRef` is process-global.**~~ **FIXED on `main` at `c7ae106`, outside this wave (swept 2026-09-22 at
  `d297b29`).** `grep -rn runFactsRef src/` is empty. The facts are a per-`runId` registry:
  `src/synth/introspect/facts.ts` holds a module `Map<string, RunFacts>` bounded by `RUN_FACTS_MAX = 8` with
  `setRunFacts(runId, …)` / LRU eviction, so two interleaved synthesizers in one `src/bench/runner.ts` process read
  their own run's facts across an await. **Consequence for the plan:** the `--concurrency 1` pin on the fast-path arms
  is no longer forced by this defect (Q9, below, says the same); if the arms keep it, they keep it for measurement
  noise, which is a different and weaker reason.
- **Nothing drops a run's search memory.** `memories` is a module-level `Map` with `MEMORIES_MAX = 4`
  (`src/synth/search/memory.ts:200`, LRU eviction at `:207`, `dropMemory` at `:219`) and no run-end hook. A
  Django-scale memory is ~0.4 GB.
- **`DANGEROUS_COMMAND` is mock-only.** `src/jev/mock.ts:24`:
  `/rm -rf|git push --force|sudo|curl[^|]*\|\s*sh|mkfs|:\(\)\{/`, used only at `mock.ts:194` and referenced in a
  comment at `src/jev/off.ts:21`. **It is not production code.** Two of three designs named it as the surviving
  production risk gate; it is not one.
- **The loop's own `run` action has no scope guard.** `scopeUsable` (`src/workspace/tests.ts:540`) guards only
  the sieve's runner. A generator-proposed narrow test command that collects nothing reads as green to the judge.

---

## §2 The router table

### 2.1 The primitive

`src/jev/router.ts` (new, slot B):

```ts
export const ROUTER_DEADLINE_MS = 400; // Jev p50 237 ms, p95 547 ms

export type RouterId = 'RL1' | 'RL2' | 'RL4' | 'RL6' | 'RS1' | 'RS2' | 'RS3' | 'RS4' | 'R9';

export interface RouteResult<T> {
  readonly order: readonly T[];
  readonly source: 'jev' | 'code';
  readonly appliedAt: number | null;
  readonly dropped: boolean;
  readonly id: RouterId;
  readonly waitMs: number;       // I3, MEASURED: held wall minus the ask's own elapsed time (0, or a bug)
  readonly heldMs: number;       // the raw wall entry -> settled race; what makes waitMs falsifiable
}

export interface RouteInput<T> {
  readonly id: RouterId;
  readonly token: StepToken;                            // I4: invalidated at step commit
  readonly codeOrder: readonly T[];                     // non-empty, sufficient alone
  readonly dispatch: (item: T) => Promise<unknown> | void; // called in THIS tick, before any await
  readonly ask: (signal: AbortSignal) => Promise<readonly T[] | null>;
  readonly deadlineMs?: number;
}

export function routeSpeculative<T>(input: RouteInput<T>): Promise<RouteResult<T>>;
```

Semantics, in order:

1. `dispatch(codeOrder[0])` runs **before anything is awaited**. The code order is not a fallback that is reached
   after a failure; it is the order the step is already executing.
2. `ask` is issued in the same tick under a controller linked to the step signal (`linkedAbort`, re-exported at
   `src/provider/sse.ts:539`).
3. An answer landing inside `deadlineMs`, before the in-flight item settles, and **while `token.valid`** re-orders
   only the **pending tail**.
4. A deadline, a `JevError`, a 503/529, an invalidated token and a malformed answer are **one branch**:
   `dropped: true`, code order stands, nothing thrown. This single failure branch is what makes "a Jev outage is
   slower, never wrong" a structural property rather than a per-site promise. **It is JEV's failures only** (as
   built; review 2026-09-22, defect 5): an aborted step signal (a human pause, `/stop`), a wall-time
   `BudgetError`, a `JevModelDriftError` and a `QuestionBuildError` are the harness's own stop conditions and a
   programming error, not an outage — `isRouterFatal` sends them back up unchanged, exactly as they travel with
   routers off. Swallowing them is how an aborted run keeps executing stages, and how the risk stage handed the
   engine a verdict to act on after the run had been paused.
5. The thunk is **injected**: `ask` is the stage's existing `ctx.ask`, which already routes through
   `askRecorded`. No router touches `engine.ts` except through the one `askRecorded` seam slot B owns.
6. A dropped ask is **cancelled** (as built; review 2026-09-22, defect 2): the router aborts the linked
   controller whose signal it handed the thunk, naming the router and the drop in the reason, and the routed
   stages' annotate callbacks return early when that signal is aborted or their step's token has been
   invalidated. Until the `askRecorded` seam takes a per-call signal the *request* still runs on — what it may
   no longer do is write a verdict into a dropped answer's rows.

The listener the abort race installs on the caller's run-scoped signal is removed in the same `finally` as the
timer and the `linkedAbort` unlink; one leaked listener per routed ask is ~120 by step 40 (review 2026-09-22,
defect 1).

The `ask` is still made, still metered, still written to `jev.jsonl`. `jevMs` may grow. `routerWaitMs` reads 0 —
**measured, not written**: `heldMs` is the clock from entry to the settled race and `waitMs` is what is left of it
after the ask's own elapsed time, less `ROUTER_SETTLE_SLACK_MS` (2 ms, the microtask hop `Date.now()` makes
visible). A hard-coded `0` asserted nothing; the measured pair shows the deadline working as a ceiling (a 500 ms
ask behind RL1's 250 ms deadline holds the step ~250 ms, and adds nothing to it).

Two flavours. **Order routes** re-order a pending tail. **Branch routes** pick between branches whose code
default is already running — R9 is the only one in this wave.

### 2.2 The table

`routers: 'off'` (the default on `main`) leaves every row exactly as it is today.

| id | ask today | becomes | code fallback (and its named test) | deadline | consumer | cost of a dropped or wrong answer |
|---|---|---|---|---|---|---|
| **RL1** | Q7 intent, `stages/intent.ts:195` | order route | `INTENT_FALLBACK = 'investigate'`, or `codeIntent(lastProposal.kind)` when a previous step exists — `test/unit/loop/router.test.ts` › *intent falls back to investigate when the decider throws* | 250 ms | the prompt's intent section only | one sentence of one prompt |
| **RL2** *(built in the finishing pass, §7.5b — not in slot B)* | Q2–Q6 context, `stages/context.ts` | order route over the code pre-filter | today's pre-filter order; traceback frames and changed files are always members — › *context keeps the traceback frame when the decider throws* | 400 ms | `contextFiles`, the prompt's file section | a worse file order in one prompt |
| **RL3** | risk, `stages/risk.ts:688` / `:741` | **NOT a router — a code-first gate with Jev as a verifier** (§2.4) | `dangerousCommand()` (new, `src/jev/danger.ts`) decides `review`; `codeRiskReason()` (`risk.ts:364`) decides `allow`; Jev's Scores may only **escalate** — › *risk yields the code verdict with `jevUnavailable` when the decider throws* | — | execution | the code verdict stands, `riskSource: 'code'` recorded |
| **RL4** | judge Q19/Q21, `stages/judge.ts:226`, `:261` | **recorded-only** (adopting `llm-jev`'s rule) | the code comparison of parsed failing counts — › *judge outcome is the parsed counts when the decider throws* | 400 ms | the plan note | none: a wrong Noul is data |
| **RL5** | completion Q22, built `stages/complete.ts:16`, **decided `engine.ts:4514`** | **recorded-only on evidence-bearing steps** (§2.5) | `isCompleteByFact()` (`complete.ts:243`) over the harness's own current, passing run — › *completion is the engine's own run when the decider throws* | — | the stop rule | none |
| **RL6** | Q18 `next_move`, `stages/replan.ts:215` | order route for the **directive**; `stop_and_report` and `task_impossible` become **recorded-only** | `REPLAN_FALLBACK = 'change_approach'`; stopping is the loop detector, the step cap and the wall cap — › *replan continues on the code directive when the decider throws* | 500 ms | the next step's directive text | a worse directive for one step |
| **RS1** | *(new)* Q23 `run_first`, `src/synth/oracle/scope.ts` | order route | `scopeBuilderFor` order — › *scope order is the code builder's when the decider throws* | 250 ms | which scope runs first | a worse first run |
| **RS2** | Q7 edit class, `search/subgoal.ts:156` | order route | `null` prior = the code site order — › *edit class prior is null when the decider throws* | 300 ms | site ordering | a worse site order |
| **RS3** | `gateHeldPartial`, `search/subgoal.ts:763` | order route | the code hold rule — › *held partials use the code rule when the decider throws* | 300 ms | hold release | a partial held one round longer |
| **RS4** | `deps.rank`, `search/subgoal.ts:864` **and `:1617`** (C2: *not* `:848`/`:1575`) | order route | enumeration order (`llmJobPrior`) — › *rank falls to enumeration order when the decider throws* | 600 ms | top-k | **never fires inside a fast-path round** (SIEVE only) |
| **RS5** | Q15/Q16 arbitration, `search/guard.ts:1039`, `:1078` | **NOT a router** — awaited | already escape-bearing; bounded by `FASTPATH_JEV_MAX` inside a round | — | which passer | quality only |
| **R9** | *(new)* the bounded sieve round | **branch route, code-decided — no Jev question is added** | the LLM proposes through `proposeWithContext`, exactly as today | n/a (§4.3 budget) | the step's proposal | at worst one round's wall, charged to the step |

**RL2's deadline is the one number in that column measured on a DIFFERENT batch** (finishing-pass review,
defect A7). `ROUTER_DEADLINE_MS = 400` is justified by "Jev p50 237 ms / p95 547 ms" (§1.3), a figure for the
loop's asks **in general** — and every one of those is a single Choice or a handful of Nouls. RL2 sends the
largest batch on the loop: one Noul per candidate, up to `CONTEXT_MAX_CANDIDATES` = **300**
(`buildContextQuestions`). Nothing in this document or in the diff measures a 300-Noul batch, and the site
passes no `dispatch`, so clause 1's overlap does not apply either: the step simply waits up to 400 ms and then
discards. If that batch is routinely slower than the deadline, `jev-on-next` does not gain a route at RL2 — it
**loses Jev context selection** and runs `selectCandidatesCode` on every step, which is a worse arm, not a
faster one.

Sizing the constant needs a measurement against a real Jev, and it is **open**. What the finishing pass could
do offline is remove the word "silently": `RouteResult.drop` now rides the ledger row and reaches
`StepRecord.router.rows[].drop` (`'deadline' | 'error' | 'aborted' | 'committed' | 'empty' | 'work_settled'`).
Before that every non-application was one undifferentiated `dropped: true`, and an arm that had quietly given
up on Jev context selection looked exactly like an arm Jev was down for. **So the measurement §8 needs is now a
read of the first `jev-on-next` run's own `steps.jsonl`, not a new experiment:**

- `drop: 'deadline'` on most RL2 rows ⇒ the deadline is the binding constraint; resize
  `RL2_CONTEXT_DEADLINE_MS` from the observed batch latency and record the new figure in this table;
- `drop: 'error'` ⇒ Jev was unavailable, and I1 did its job;
- no `drop` ⇒ the answer was applied and 400 ms is right.

**Until that read, the arm's RL2 column is unvalidated and must be reported as such.** Passing `dispatch` is
*not* the alternative it looks like: RL2's dispatched unit is the whole selection, so the local file reads would
settle in milliseconds and `work_settled` would drop Jev's answer even more often than the deadline does.

**Deferred, with reasons.** R3 `prewarm_first` (the warm plane is off, I8). R4 `same_situation` (the exact-digest
cache in `src/jev/cache.ts` already landed). R5 compaction `keep_<i>` (compaction is code-only). R7 (needs the M8
index). R8 `finishes_within_step` (needs `src/sandbox/background.ts`, absent).

### 2.3 The four-clause block text, per site

Every routed site carries this block immediately above its `.ask(`, and its allow-list row in
`scripts/jev-contract.mjs` is **deleted or tightened** in the same commit (I11). The four clauses are: an escape
option, a guard, a fallback **naming its own test**, and no gating.

**RL1 — `src/loop/stages/intent.ts`:**

```
// jev-contract (RL1, docs/LLM-LOOP-DESIGN.md §2.2):
//   escape:   the Choice carries `none_of_these`; resolveChoice returns the escape as a non-answer.
//   guard:    routeSpeculative issues under the step signal with a 250 ms deadline and a step-scoped token;
//             the answer may only re-order the pending intent list, never add an option.
//   fallback: INTENT_FALLBACK = 'investigate' (or codeIntent(lastProposal.kind)); the context stage has already
//             started on it. Test: test/unit/loop/router.test.ts › "intent falls back to investigate when the
//             decider throws".
//   no gate:  the answer reaches one sentence of the prompt's intent section. It cannot stop the run, block an
//             action, or withhold a candidate.
```

**RL2 — `src/loop/stages/context.ts`:**

```
// jev-contract (RL2, §2.2):
//   escape:   Nouls only; an unanswered Noul is inert and leaves the code order in place.
//   guard:    the code pre-filter enumerates the candidate set; Jev may only re-order the UNREAD tail, and
//             traceback frames and changed files are members whatever Jev answers.
//   fallback: the code pre-filter order (mention count, then recency); FilesInView has already stats-and-read
//             the code-ordered head. Test: test/unit/loop/router.test.ts › "context keeps the traceback frame
//             when the decider throws".
//   no gate:  ordering only. No file is withheld by a missing answer.
```

**RL3 — `src/loop/stages/risk.ts` (a gate, not a router):**

```
// jev-contract (RL3, §2.4) — THIS SITE IS A GATE, NOT A ROUTER, and its polarity is ratified in
// docs/DECISIONS.md (2026-09-22, "the risk verdict is code-first").
//   escape:   the Scores carry their escape; an unanswered Score is inert.
//   guard:    the verdict is computed by CODE FIRST — dangerousCommand() (src/jev/danger.ts, a DENY-LIST, not a
//             proof) yields `review`; codeRiskReason() (risk.ts:364, an ALLOW-LIST of safe cases) yields `allow`;
//             neither yields `allow` for an arbitrary `run`. Jev's Scores may only ESCALATE the code verdict
//             (allow -> review -> block); they can never de-escalate and never block alone.
//   fallback: a dropped or failed ask leaves the CODE verdict with StepRecord.jevUnavailable = true and
//             StepRecord.riskSource = 'code'. Test: test/unit/loop/stages/risk.test.ts › "a throwing decider
//             yields the code verdict, jevUnavailable and riskSource 'code'".
//   no gate:  Jev does not gate — code does. A Jev outage cannot allow what code blocks, and cannot block what
//             code allows.
```

**RL4 — `src/loop/stages/judge.ts`:**

```
// jev-contract (RL4, §2.2):
//   escape:   Q19/Q21 carry their escapes; recorded-only, so an escape costs nothing.
//   guard:    the outcome is the harness's own parsed test counts; Jev's Nouls are written to the record and
//             read by nothing.
//   fallback: the code comparison of failing counts. Test: test/unit/loop/router.test.ts › "judge outcome is the
//             parsed counts when the decider throws".
//   no gate:  recorded-only.
```

**RL5 — `src/loop/stages/complete.ts` (question) + `src/loop/engine.ts:4514` (decision):**

```
// jev-contract (RL5, §2.5):
//   escape:   Q22 carries its escape.
//   guard:    on a step carrying ProposalEvidence the decision is Engine.completeAfter -> isCompleteByFact()
//             (complete.ts:243) over the engine's OWN current, passing run; `task_complete` is recorded only.
//             On a step with no evidence the rule is unchanged.
//   fallback: isCompleteByFact() is code and needs no answer. Test: test/unit/loop/router.test.ts › "completion
//             is the engine's own run when the decider throws".
//   no gate:  a missing or wrong Noul cannot complete a run and cannot prevent one completing.
```

**RL6 — `src/loop/stages/replan.ts`:**

```
// jev-contract (RL6, §2.2):
//   escape:   the Choice carries `none_of_these`.
//   guard:    the answer supplies the DIRECTIVE only. `stop_and_report` and `task_impossible` are recorded-only
//             under routers:'on'; the run's stops are the loop detector, the step cap and the wall cap, all code.
//   fallback: REPLAN_FALLBACK = 'change_approach'; the next step has already started on it. Test:
//             test/unit/loop/router.test.ts › "replan continues on the code directive when the decider throws".
//   no gate:  a dropped answer continues the run. It can never end one.
```

**RS1–RS4** carry the same shape against `scopeBuilderFor`, the null prior, the code hold rule and
`llmJobPrior` respectively, each naming its own test in `test/unit/synth/search/router.test.ts`.

### 2.4 RL3 in full: the risk polarity change

This is the one safety-relevant change in the wave and it is **not** a corner-case footnote.

Today: a failed Q20 means **ask-or-decline, never allow**. That is stated in `docs/HARNESS-NEXT-DESIGN.md` §1.2
and in the allow-list row for `src/loop/stages/risk.ts` (`jev-contract.mjs:34`: *"code deny-list first, a failed
ask means ask/decline, never allow"*).

Under `routers: 'on'`: a dropped or failed harm ask yields the **code verdict**.

**These contradict.** The change is therefore gated on three things, all of which must land before slot B merges
(graft, judge 1 §3 and judge 2 §8):

1. **A production deny-list.** `DANGEROUS_COMMAND` moves out of `src/jev/mock.ts:24` into
   **`src/jev/danger.ts`** as `dangerousCommand(command: string): string | null`, with a **table-driven test**
   (`test/unit/jev/danger.test.ts`) covering each alternation and the obvious evasions. The doc and the module
   docstring both say, in terms: **it is a deny-list, not a proof.** `src/jev/mock.ts` re-exports it so the mock
   decider's behaviour is unchanged and the golden holds.
2. **An explicit ratification row in `docs/DECISIONS.md`**, written before slot B lands, naming the contradiction
   with §1.2, the exposure (a harmful command the deny-list misses **during a Jev outage**, in a mode where the
   risk ask would previously have forced an ask), and the reversal trigger.
3. **An audit trail.** `StepRecord.riskSource: 'code' | 'jev'` (graft, judge 1 §10) alongside
   `StepRecord.jevUnavailable`, so every step where the harm ask was dropped and the code verdict stood is
   auditable after the fact. That is what makes the ratified change reversible **on evidence** rather than on
   argument.

The allow-list row `{ file: 'src/loop/stages/risk.ts', sites: 2, why: '… a failed ask means ask/decline, never
allow' }` is deleted and replaced by the two four-clause blocks of §2.3.

In session mode `classifyBlocking` still offers the `jev-unreachable` pause; it is simply no longer the only
outcome.

### 2.5 RL5 and RL6 in full: the two stop-rule changes

**RL5 (completion).** Guarded to steps carrying `ProposalEvidence`, which in `jev-on` today is **zero steps** —
so I2 (byte identity when off) holds trivially, and even with `routers: 'on'` nothing changes until the fast path
fires. But the moment R9 commits, a run can complete on a code fact where today it would wait for Jev's Noul.
That is the intended direction (completion is structurally excluded from Jev, §1.2 of the harness doc) and it is
a **behaviour change named in CHANGELOG**, not smuggled in as additive.

**RL6 (replan stop).** Demoting `stop_and_report` removes a stop the tree relies on: the iteration-1 record
shows **every** `llm-jev` SWE run ending in `replan_stop` at 5 steps of a 25-step budget. `main` has already
moved *part* of the way here without this wave — `oos-iter-2` change 9 (`9a161a1`) makes a refused completion
claim climb `PHASE_ESCALATION` (`src/loop/stages/replan.ts:138`) before any move may end the run, because that
deadlock, not a mis-routed Q18, was the actual cause of the 5-step stops. RL6 is the remaining, larger step: it
removes the Jev-decided stop entirely. Those runs will then burn their step cap instead. The polarity is right under I1 — a mis-routed Q18 is currently a *lost task* — and the code loop
detector, the step cap and the wall cap are unchanged, so the worst case is a **cap exit instead of an early
exit**. The cost is real and lands in the `$/task` column, which §8 reports and which must be inspected before
the arm is judged on solve count alone.

### 2.6 Concurrency: the step token (I4)

```ts
export interface StepToken { readonly step: number; valid: boolean; }
```

The engine mints one per step in `runStep` and sets `token.valid = false` at step commit, in the same `finally`
that writes the `StepRecord`. `routeSpeculative` checks `token.valid` immediately before applying an answer and
records `dropped: true` otherwise. Unit tests: *"an answer landing after step commit is recorded dropped and
applied to nothing"* (the primitive) and *"a router answer landing after step commit is dropped, and the
committed step cannot be resurrected"* (the loop), both driven by a decider that resolves on a timer past the
commit.

**A committed step stays committed** (as built; review 2026-09-22, defect 6). `stepTokenFor` and `noteStepRoute`
reach the step's state through `stateFor`, which used to re-create it lazily — so either call after
`commitStepRouters` minted a FRESH VALID token for the committed step and a ledger nobody would ever commit, and
`noteStepRoute` runs after every route resolves. `src/loop/routers.ts` keeps a bounded set (64) of closed
`(runId, step)` keys: a closed key gets a permanently-invalid token and a throwaway ledger, `commitStepRouters`
closes the key before its early return, and the two-step live LRU closes what it evicts.

**What the token promises, and what the seam added.** The token guards *application*, at the router and again
inside each routed stage's annotate callback. Stopping the engine *writing* was the §7.5 seam's job and landed at
`c811899` (§7.5a item 1): `ctx.ask` takes a per-call signal, so the dropped request is genuinely cancelled, and a
decider that ignores it and answers anyway is **abandoned** after the await — no metering, no `jev.jsonl` row, no
`decision` event, no `draft` mutation. The annotate-callback token check stays: it is the one drop the signal
cannot see, an answer landing after commit under a signal nobody aborted.

---

## §3 The S2 generator path

Slot A. Unchanged in intent from `docs/HARNESS-NEXT-DESIGN.md` §6 S2, with one change of justification: the
prefix work now pays on the mode this design is making primary, which answers the standing objection that S2
optimised two non-default modes.

### 3.1 TTFB

A first-byte callback on `src/provider/sse.ts`, beside the existing `firstByteTimeoutMs` (`:158`, `:235`). No
behaviour change: `onFirstByte?: (ms: number) => void` is threaded through `src/provider/types.ts` and
`src/provider/http.ts` into the four clients and surfaces as `StepVerifySummary.ttfbMs?: readonly number[]`.

### 3.2 Hedging

In `src/synth/llm/source.ts` and `src/synth/search/llm.ts`:

- `hedgeAfterMs = clamp(2 × running TTFB p50, 3_000, 8_000)`.
- `LLM_HEDGES_PER_ROUND = 1` (`src/core/limits.ts`, additive).
- A new `CancelReason 'hedge'` in `src/provider/types.ts`.
- **Refused unless the budget can hold one more estimated-full-cost sample.** Cancels are booked at full cost, so
  a hedge storm cannot leave a goal with zero rounds.
- The twin rotates the provider order, so a 429 on the original leaves the twin live.
- The hedge never increases `PROPOSE_MAX_ATTEMPTS` (still 2) and never re-asks a call the provider dropped at its
  own deadline (`DROPPED_CALL_STOP_REASON`, `src/loop/stages/propose.ts:27`).
- Recorded as `hedges` / `hedgeWins` on `StepVerifySummary`.

### 3.3 Byte-stable prefix

`src/provider/prompts.ts`: fix the prefix order **system → repo map → files → window** so that
`assembleLegacy` / `assembleRelaxed` produce a cacheable head that is byte-stable between steps.

**This must not change `view: 'legacy'` prompt bytes for a run that does not intend it.** The golden tests are the
gate. If the current legacy order differs, the reorder is applied **only** under the new arm's assembly path and
the legacy golden is unchanged — a prefix that costs a golden re-capture is not worth the cache hit, and slot A
must state which it did.

### 3.4 Reasoning cap and cache accounting

`reasoning: { maxTokens: 256 }` on the cheap classes only. `cached_tokens` (already parsed) surfaces as
`cacheRead` / `cacheWrite` / `cacheHitRate` on `StepVerifySummary`, with `cacheInput` — the rate's own denominator —
beside them (F19), so a run or an arm recomputes the rate as `Σ read / Σ input` over its steps instead of averaging
the steps' ratios: 10/1,000 with 90/100 is a true 9.1 % and a mean-of-ratios 45.5 %. `StepsSummary.s2` carries
`cacheInput` and NOT `cacheHitRate`, for that reason; `src/bench/report.ts` prints the recomputed rate.

**The denominator covers the rounds whose provider REPORTED cache, not every round** (B5, F26 in §9.1). `LlmSource`'s
`cacheCountsOf` returns nothing at all when a round's samples reported neither a cache read nor a cache write, so a
round that served 1,000 uncached input tokens contributes neither numerator nor denominator, and the arm's printed
rate is `Σ read / Σ input` over the REPORTING steps — a number that can only overstate. Until F26 lands, the report
row and this sentence say so rather than claiming a share of the arm's whole input; the mean-of-ratios error F19
removed one level down is still removed, and this residual is the same error one level up, bounded and named.

### 3.5 `--quick`

`src/bench/cli.ts` gains `--quick` (slot A owns `cli.ts`; slot D owns every other `src/bench` file). Global caps
per `HARNESS-NEXT-DESIGN.md` §3 M16.

**As built, 2026-09-22 (`d297b29`):** the preset is in `src/bench/cli.ts` AND the flag is typeable — the `'quick'`
row landed in `src/cli/args.ts` at `0fb7af3` (`:86` in `BOOLEAN_FLAGS`, `:278` in `FLAGS`, `commands: BENCH`), so
`jevcode bench --quick` parses. Everything below that describes the flag as unreachable is struck in place.

**`src/core/limits.ts` is additive only**, and constants that belong to one owner live beside that owner —
`LLM_HEDGES_PER_ROUND` in limits (shared), `ROUTER_DEADLINE_MS` in `src/jev/router.ts`, the `FASTPATH_*` constants
in `src/loop/stages/fastpath.ts`. This is what keeps slots A and C from colliding in limits.ts.

### 3.6 As built (slot A, after review — 2026-09-22)

Six refinements the review of the slot-A branch forced, each one a thing the section above left implicit and the
first implementation therefore got wrong. They are the normative reading of §3.1–§3.5 from here on.

1. **§3.1 reaches production.** "Threaded into the four clients" is not enough: the sanctioned generator channel
   is `SynthesisContext.generate`, and `SampleOptions` carried no callbacks, so `onFirstByte` never left the
   synthesizer. `SampleOptions` now carries `onFirstByte?` and `onCancelled?` (contract 1.9, additive) and
   `src/loop/engine.ts` forwards both — the engine keeps its own `onCancelled` for the generator.jsonl row and
   calls the synthesizer's as well. Without this hop `p50TtfbMs()` is permanently null, the §3.2 threshold is
   pinned at its ceiling and the "cancelled the moment its first byte lands" rule never fires.
2. **§3.1 is once per `generate()`, not per attempt** (`reportFirstByte`, `src/provider/sse.ts`). `withRetry`
   wraps the whole attempt, and a retryable error frame on a 200 lands after the stream opened.
3. **§3.2 hedges only the source's CURRENT round.** A superseded round drains with its accounting but no reader:
   a twin fired there spends a live sample on an arrival that is discarded.
4. **§3.2's `hedgeWins` is the twin's delivery**, not the loser's cancellability — the recorded shape the hedge
   exists for is an origin that is already a zero-token timeout when the twin answers. And `p50TtfbMs()` needs
   `LLM_DEADLINE_ADAPT.minSamples` readings, like every other running statistic in the source.
5. **§3.3's head is task → repo map, and the repo map is the STABLE half of `## Workspace`.** The changed-file
   list grows at every edit of a run, so it moves behind the step heading (`## Workspace (changed by this run)`)
   and `prefixChars` counts only what is guaranteed to repeat. The file bodies keep their §3.3 position but are
   not counted: in jev-on Jev reselects them per step.
6. **§3.4's figures are recorded**, through the hop the §9.3 counts already take: round summary →
   `GoalSearchTrace.llm` → `SynthesisContext.reportVerify` → `StepRecord.verify`, each member absent when nothing
   measured it. ~~§3.5's `--quick` remains unreachable from a command line until `src/cli/args.ts` carries the
   `'quick'` row~~ — **struck 2026-09-22 (`d297b29`): the row landed at `0fb7af3`** (`src/cli/args.ts:86` in
   `BOOLEAN_FLAGS` and `:278` in `FLAGS`), so `jevcode bench --quick` parses and the preset applies;
   `test/unit/bench/quick-preset.test.ts` pins that it parses. The header comment in `src/bench/cli.ts` that still
   stated the rejection is code and was outside the documentation slot; F23 corrected it on `finish-B`, and the
   matching `DEFERRED` row `experiments/harness-next/quick.mts` printed at every Ring run went with the
   finishing-pass integration.

### 3.7 As built, the engine's side of §3.2 (`c811899`)

Slot A's **defect 11**: the twin and the round counter. `Engine.noteSampleEnd` drops `generatorBatch.inFlight`
to 0 in `generate`'s own `finally`, which runs **before** the source's `handleEnd` / `settle` has marked the
origin served and cleared its hedge timer. A twin started in that window found `inFlight === 0` and opened a
second round for one batch — `draft.llmRounds` 2, so `PausePoint.llmRound.round` (contract 1.4 §12.0.2 P3, "one
round per sample batch") named a round the synthesizer never ran, and the batch wall restarted mid-round.

A twin is by definition a second copy of a sample of the round already open, and it says so in its own index
(`HEDGE_TWIN_OFFSET` / `hedgeOriginOf`). `noteSampleStart` now takes the sample index: a twin takes the open
batch's wall when it is the only sample in flight and **never** the round counter. Every other index is
unchanged. See §7.5a for what was and was not confirmed about reaching that window from `source.ts` today.

---

## §4 The synth fast path (route R9)

### 4.1 What it is

One bounded `synthesize()` round, entered from the `jev-on` propose branch, which either returns a
cold-confirmed patch that becomes the step's proposal or declines and lets the LLM propose as usual. It is not a
race, not a mode, and not a second step. It is a **branch route**: the code default (the LLM proposal) is what
runs when the route declines, and the round's prompt assembly (pure, no network) may proceed in parallel, which is
where the overlap saving comes from.

### 4.2 What it actually calls

`src/cli/session.ts` builds a `Synthesizer` only for `jev-only | llm-jev`, and `src/cli` is outside this owner
split. Therefore **the fast path owns its own synthesizer**: the facade lazily calls

```ts
createSynthesizer({ decider: <the engine's>, redact, mode: 'jev-only' })
```

on first trigger, **once per run**, keyed by `runId`. Verified reachable: `src/synth/index.ts:320` —
`if (mode === 'jev-only') return Object.assign(new LedgerSieveSynthesizer(searchDeps()), { mode });` — no LLM
source, no `generate`, no throw.

This is the fact that decides the design. A fast path that requires the *engine's* synthesizer is
**permanently ineligible for real users** in `jev-on` (`engine.ts:1005`: `this.synthesizer = init.opts.synthesizer ?? null`)
and fires only in a bench that supplies one — which measures a configuration the shipped `jev-on` cannot reach.
That is the opposite of an attributable bench, and it is why this design builds its own.

Choosing `'jev-only'` is the design, not thrift (I6): on the ten OOS QuixBugs programs the LLM source contributed
**0** passers. The regime the predicate admits is exactly the one the sieve wins **without a sample**.

The call is `synthesizer.synthesize(sctx)` — the whole-step callable — **not** a re-entry at `searchSubGoal`
(§1.5). The engine already builds the required `SynthesisContext` at `engine.ts:3078` (`synthesisContext(draft,
contextFiles)`); `generate` is optional and omitted (the fast path's synthesizer is `jev-only` and has no LLM
source). `reportVerify` is **installed in every mode** as of the finishing pass (F04): gating the recording
channel together with the LLM channel made `JEVCODE_WARM=on --mode jev-only` a silent no-op, and it is also the
hop §3.4's S2 figures take on the jev-on propose path. It costs nothing when nobody calls it — `StepRecord.verify`
is written only when something was reported (or in llm-jev, where the synthesizer proposed).

### 4.3 The trigger predicate — two stages, structural, no task names

The predicate prices its own false positive, which is why it is split. Stage 1 is free; stage 2 costs one baseline
run plus the localiser's routed asks, and `T10` makes that cost payable **at most once per fingerprint per run**.

#### Stage 1 — engine-side: pure code, zero Jev, zero LLM, zero test runs

All must hold.

| # | condition | source |
|---|---|---|
| T1 | `mode === 'jev-on'` and `fastPath === 'auto'`, and the warm plane is OFF (`warmPlaneEnabled()`, I8 — §4.5) | option, `src/synth/warm/plane.ts` |
| T2 | `synthesizerHandles(wsInfo, files)` true (cached once per run) | `src/synth/index.ts:305` |
| T3 | the last executed action was a test `run` (`isTestCommand`, `stages/execute.ts:33`) whose parse is **`scopeUsable`** with `failed + errors >= 1` | `src/workspace/tests.ts:540` |
| T4 | no workspace write since that run (`lastChangeStep` / `changedFiles`) | engine state |
| T5 | `lastTestRun.durationMs <= FASTPATH_MAX_T_RUN_MS = 800` | **new contract-1.9 member** (§5) |
| T6 | the code-derived suspect set — `framesOfTraceback` ∩ workspace files, plus `mentionedInTask` — is **exactly one** non-test source file | `search/index.ts:1621`, `:360` |
| T7 | failing test count ≤ 8 (one cluster, not a broken build) | parsed counts |
| T8 | `isRepositoryWorkspace(testCommand, paths)` false and `detectLayout(paths) !== 'other'` | `search/index.ts` |
| T9 | spend remaining > 0, and **wall left ≥ 2 × the fast-path budget** | budgets |
| T10 | this `(file, failing-test-id-set)` fingerprint has not already been declined or exhausted this run — the IDS, read out of the run's own output by `fastPathFailingIds` (the oracle's own `summarize`); the failing/errors COUNTS are the fallback used only when the output named no test, because two different clusters with equal counts share a counts key and the second would read as `fingerprint_seen` | per-run set |
| T11 | `goal.attempts < FASTPATH_ATTEMPTS_MAX = 2` for this cluster, and **the fast path is not disarmed** (§4.5) | per-run state |
| T12 | the loop detector is not tripped, no pause point is pending, and no coordination lease conflict is known on the implicated file — the LEDGER's verdict (`CoordinationRuntime.conflictOn`, the same pure `check()` the coordinate micro-stage runs over the already-folded ledger), never this run's own dirty-file list: a file this run modified earlier is not a lease conflict and must not be counted as one in §8 | engine state + `src/loop/coordination.ts` |

**T5 is the graft that makes the predicate survive a resume** (judge 1 §7). Reading `t_run` "off the engine's own
clock" does not survive a process restart: `LastTestRun` (`src/core/types.ts:1066`) has **no duration** and
`lastTestRunOutput` (`engine.ts:860`) is **in-memory only**. `LastTestRun.durationMs?: number` is therefore a
contract-1.9 member, and after a restart the predicate records the honest reason `'no_parsed_run'` rather than
arming blind.

**T3 also lands a guard the loop has never had** (judge 1 §7): `scopeUsable` is today used *only* by the sieve
runner. Applying it to the loop's own test run closes the "narrow test command reads as green" hole **for the
fast-path trigger**. The verdict is recorded on every step **even when the fast path is off** (§5), so the same
hole in the *judge* — which this design does not fix — becomes visible in the data.

**T9 and T11 are the wasted-wall bounds** (graft, judge 1 §6): never enter a round that cannot finish, and
one-strike disarm.

#### Stage 2 — inside the facade, after the synth's own baseline + `fitOracle` + `locate`, before one candidate runs

The verdict is **per round and reached on a measurement that round made**. `RunMemory` outlives the round (one
synthesizer per `runId`), so `mem.baseline !== null` does not mean "this round measured one": the facade records the
round's ENTRY baseline and the clamp's `observe` judges only a baseline whose identity differs from it — otherwise
round 2 would abort on round 1's oracle at the `freshBudget` that runs before the re-baseline a changed workspace is
about to force. The wrapped localiser is the deterministic point (after the baseline, before any candidate is
enumerated, and the only place the real site count exists); a round that reaches neither is judged on its last
measurement at the end, and a round that measured nothing at all takes §4.7's `empty_step_budget` row (disarm,
`outcome: 'error'`) rather than proposing out of a round whose eligibility was never established.

**The fast path fires iff the round would be a SIEVE round.**

- `oracleClass(oracle) === 'quixbugs_class'` (`budget.ts:648`: goal-subset < 2 000 ms **and** full suite < 10 000 ms), **and**
- `loc.sites.length <= FASTPATH_MAX_SITES = 16`, **and**
- `decideRunPlan(pool, site, oracle, fastBudget, { sitesLeft }).mode === 'SIEVE'` at the first site.

This is the regime line **expressed in the code that already draws it** — `poolFitsRunBudget(n, left) => n <= left`
(`budget.ts:222`, the entire SIEVE cut as of OOS ranked change 1 at `budget.ts:946`) — rather than a hand-set
threshold. Every measured disaster is a RANK round and is refused here: `sympy-16792` enumerated 28 878 against
1 191 testable and spent 178 sieve requests ordering a pool 24× its run budget. The ladder multi-hunk shape (one
module, several failing tests, 4/6 vs 0/6) satisfies T6 and lands in SIEVE.

On a stage-2 miss the facade returns `{ kind: 'declined', reason }` having spent **one baseline run plus the
localiser's ≤ 5 routed Jev requests**. That is the honest worst case of a false stage-1 positive, and it is why
the **stage-1-fired / stage-2-declined ratio is a first-class blocking bench row with a stated failure threshold**
(§8): a ratio above **0.3** on any suite means the *predicate* is wrong, not the budget.

RANK mode is ineligible by construction, so the fast path never pays iteration 1's 6 960-ranked-against-20-tested
failure, and **RS4 (`deps.rank`) never fires inside a fast-path round.**

### 4.4 The budget

Installed explicitly, never inferred, and never by lying to the synthesizer about the run's limits (§1.6).

`ControllerOptions` (`src/synth/search/index.ts:163`) gains:

```ts
  /** contract 1.9 (Fastlane) §4.4: the one-round clamp the fast path installs; absent = the unclamped round */
  fastPath?: FastPathBudget;
```

and `LedgerSieveSynthesizer.freshBudget` applies it as a **clamp** (≈ 6 lines, slot C's first commit):

```ts
const b = freshBudget(ctx.limits, mem.oracle, this.wallRemaining(ctx, scratch), opts);
const fp = this.opts.fastPath;
if (fp !== undefined) {
  b.testRunsLeft   = Math.min(b.testRunsLeft, fp.testRuns);
  b.testWallLeftMs = Math.min(b.testWallLeftMs, fp.wallMs);
  b.jevRequestsLeft = Math.min(b.jevRequestsLeft, fp.jevRequests);
  b.llmRoundsLeft = 0; b.llmSamplesLeft = 0; b.llmUsdLeft = 0;
}
```

| dimension | cap |
|---|---|
| wall | `fastPathBudgetMs = clamp(min(FASTPATH_WALL_MAX_MS = 45_000, 0.35 × stepWallRemaining), FASTPATH_WALL_MIN_MS = 8 × tRunMs, FASTPATH_WALL_MAX_MS)` — below the floor the round cannot test enough to matter, so **decline rather than enter** |
| test runs | `min(FASTPATH_TEST_RUNS_MAX = 400, runsLeft(oracle, stepBudget))` — against QuixBugs class's own 1 500; this is one round, not a step. The engine has no oracle at stage 1, so the `runsLeft` half enters where the oracle exists: the clamp mins 400 with the synthesizer's own `testRunsLeft`, which `freshBudget` computed from the fitted oracle |
| Jev requests | `FASTPATH_JEV_MAX = 6` — up to 5 for `locate` (Q2–Q6) and one for RS5 arbitration. **Zero is legal**: with the budget spent or Jev down, `locate` falls to code order and `decide`'s `canAsk` guard drops arbitration |
| generator | **0 by construction** (`mode: 'jev-only'`) |
| full-suite runs | today's `MAX_FULL_SUITE_RUNS_PER_STEP = 5`, counted on `mem.passersThisStep` |
| cold-confirm reserve | `2 × tRunMs.fullSuite`, held **outside** the wall share |
| run-wide wall | `FASTPATH_RUN_WALL_SHARE = 0.25 × maxWallMs` over **all** rounds of the run (`FastPathRunState.wallSpentMs`) — T9 bounds one round, this bounds their sum |

**The cold-confirm reserve is held outside the wall share** because *a passer without its confirm run is not a
result*. Spending the last of the wall on one more candidate and then having no wall to confirm it produces
exactly the failure mode the fast path must never have.

**The reserve is INSTALLED, not merely computed** (review fix, slot C): the clamp sets
`testWallLeftMs = min(honest, wallMs + reserveMs)` and publishes `StepBudget.reserveWallMs = reserveMs`, which the
sieve's dispatch rule (`runQueue`'s `stopDispatch`, the streaming park and the retry loop) holds back — a run already
on a lane may spend it, no NEW candidate is dispatched into it. `reserveWallMs` is absent for every other caller and
absent means 0, so this is exactly today's dispatch rule everywhere but the fast path. Without it the counter the
confirm run debits is the same counter the candidates emptied, `budgetAllowsHold` refuses, and the round ends in a
one-strike disarm — the §4.4 failure mode, reachable.

**`budgetMs` in the record is the round's CEILING, not the share.** Only `testWallLeftMs` is clamped to the share; the
round's own baseline run, the localiser's asks and the confirm run are all outside that counter, so a round's measured
wall is routinely over its share by construction. The bound that actually holds is
`fastPathCeilingMs = wallMs + reserveMs + graceMs`, which the abort enforces, so that is what the record carries and
what R-b tests. The installed share is recorded beside it as `shareMs`.

**There is no per-step wall limit.** `Limits` bounds the RUN (`maxWallMs`, `checkBudgets`), so the share is taken of
the run's remaining wall and `FastPathBudgetInput.wallRemainingMs` is named for that. The aggregate is bounded by the
run-wide ledger row above rather than by a per-step number that does not exist.

**Three bounds, in order of who actually stops the round:**

1. `budget.testWallLeftMs` via `wallLeft()` (`src/synth/sieve/runner.ts:661`), which bounds dispatch at `:679`,
   the per-run cap at `:730`, the streaming park at `:960` and the retry loop at `:1017`. **This is the real
   intra-batch bound** (correction C1).
2. `AbortSignal.any([ctx.signal, AbortSignal.timeout(fastWallMs + reserve + FASTPATH_GRACE_MS)])` — **defence in
   depth**, honoured by `runQueue`'s stop rule and by `checkAborted`. Not the only bound, and not justified as one.
3. The engine charges the fast path's wall to the step **before** `checkBudgets(['spend_cap','wall_time'])`
   (`engine.ts:3986–3998`), and the facade **diffs its own clock** into `fastPath.wallMs` so the record is
   independent of the synth's accounting.

Money: generator `$0`. Jev requests are charged through `askRecorded` to the same step meter and spend cap as any
other ask; the measured median is 4.5 per QuixBugs task and `FASTPATH_JEV_MAX` caps it at 6 per round.

### 4.5 Verification, acceptance, and one-strike disarm

`synthesize()` returns a `Proposal`. The fast path **accepts it only when all hold**:

- `kind === 'commit'`, **and**
- the proposal's action is a `patch`, **and**
- `proposal.evidence` exists with `newlyFailing.length === 0` and a non-empty `newlyPassing`, **and**
- the passer was **cold-confirmed**: `isPlausible()` (`src/synth/search/guard.ts:1147`) saw the goal-subset run
  **and** a non-timed-out full-suite regression run with nothing newly failing.

With `JEVCODE_WARM` off (I8, mandatory here) every run is already cold, so this reduces to the regression run
existing and passing. **That reduction is a PRECONDITION, and it is enforced rather than assumed** (review fix,
slot C): nothing in a `Proposal`'s evidence says whether the run behind it was warm-screened, so a warm-screened
passer would be recorded `confirmedCold: true` on no evidence of coldness at all. `fastPathStage1Free` therefore
refuses to arm while `warmPlaneEnabled()` is true — the named decline `'warm_plane'`, before any wall is spent —
so a false `confirmedCold` is unreachable rather than merely unlikely. The fast path owns its synthesizer but not
the plane's switch, which is why the answer is "do not enter" rather than "turn it off".

Anything else — `{kind:'budget'|'parked'}`, a `run`/`done` proposal, a throw, a timeout, a dropped or unreleasably
held passer — means **the LLM proposes as usual**, and the wall already spent is the only loss.

**One-strike disarm** (graft, judge 1 §6). Any of: a round timeout, a thrown error, an unstable-oracle drop, or a
failed cold confirm **disarms the fast path for the rest of the run** (T11). Together with the two-attempt cap and
T9 these are the cheapest bounds on the wall-spent-and-not-won-back regression, which is the fast path's dominant
cost risk.

**`refused` is not `no_passer`.** The guard can refuse passers silently: `structuralRejection` and
`mutationRefused` drop them before any rule, and a lone passer under `LONE_PASSER_HOLD_MAX_NOUL = 0.3` is held
**unreleasably**. Reading only `kind` would report "no passer" when the truth is "passers found and refused". The
facade surfaces `GuardFields.dropped / structuralDrops / held / signals` into the record (`held` as the boolean
`heldAny`, because `GuardFields.held` is `HoldKind | null` and there is no count to read) and such a step records
`outcome: 'refused'`, never `'no_passer'`.

### 4.6 State ownership

- **`dropMemory(runId)`** (`src/synth/search/memory.ts:219`) is called by the engine at run end, beside
  `sandbox.killAll()` (`engine.ts:1578`, `:5378`). Today nothing does, and the module-level `memories` map
  (`MEMORIES_MAX = 4`) leaks a repository corpus (~0.4 GB) until the process exits.
- **The synthesizer instance is per-`runId`** and dropped with the memory. `scratch.startedMs` is per-instance and
  never reset across runs, so a reused instance mis-sizes every budget.
- **`observeWindow` is fed the engine's 4-entry `ctx.window` on EVERY step of an armed run**, not only on rounds.
  The synthesizer records a commit **when it proposes**; `patchNotExecutedLastStep(window)` +
  `rollbackUnexecutedPatch` are what reconcile a proposal the engine blocked, a human declined, or an apply
  failed. The window keeps only 4 entries, so a fast path that observes only on its own intermittent rounds lets
  `lastEngineRun` / `lastChangeStep` go stale and leaves the ledger claiming a commit the workspace never took.
- **Lanes** are torn down by the engine's existing `sandbox.killAll()` ladder, which the fast path goes through
  because it runs inside `runStep`.
- **`mem.tried` is monotone** for the life of a run. Three mechanisms take hashes back out and the facade must not
  assume any of them ran: `forgetUnchangedTried` after a progress commit, `requeueScreened` after a warm screen
  mismatch (warm is off), and a re-baseline dropping `mem.deferred` / `mem.subsetBaselines`. T10's fingerprint set
  is the cheap guard that makes an empty second round *unreachable* rather than merely fast.

### 4.7 Failure modes, named

| failure | detection | what the loop does | record |
|---|---|---|---|
| stage-1 miss | pure code | LLM proposes, no cost | `decision: 'declined'`, `stage: 1`, `reason` |
| stage-2 miss | after baseline + `fitOracle` + `locate` | LLM proposes | `decision: 'declined'`, `stage: 2`, `reason`, `runMode: 'RANK'` |
| `emptyStepBudget` trap | `candidatesTested === 0` with `kind: 'budget'` | LLM proposes | `outcome: 'error'`, `reason: 'empty_step_budget'` — **and the facade's first unit test asserts `candidatesTested > 0` on a known-solvable cluster**, because this failure is indistinguishable from an honest decline without it |
| localiser returns 0 sites (the Ring 1 defect — code-fixed at `0d61eef`, unmeasured) | `sites === 0` | LLM proposes, **disarm** | `reason: 'no_sites'` — **gated on Ring 1 RE-MEASURED green under `--jev off` before C merges**, because otherwise a Jev outage turns the fast path into a silent "found nothing" |
| passers found and refused | guard fields | LLM proposes, **disarm** | `outcome: 'refused'`, `heldAny`, `structuralDrops`, `dropped` |
| cold confirm failed / timed out | `isPlausible` | LLM proposes, **disarm** | `outcome: 'refused'`, `confirmedCold: false` |
| round timeout | wall bound 1 or 2 | LLM proposes, **disarm** | `outcome: 'timeout'`, `wallMs` |
| throw | try/catch in the facade | LLM proposes, **disarm** | `outcome: 'error'`, `reason` |
| abort (pause / interrupt) | `ctx.signal` | step interrupted as any propose is | `outcome: 'error'`, `wallMs`; `interruptedAt: { stage: 'propose' }` |

---

## §5 Records, events, and contract 1.9

### 5.1 The header

Inserted directly after the 1.7 line at `src/core/types.ts:16` (after 1.8 if the TUI lands it first), by the
**S4 slot (B) only**, as its own commit **B0** before any other slot writes a member (see §7.1):

```
// contract 1.9 (2026-09-22): Fastlane — speculative routers (S4), the bounded sieve fast path (route R9) and the
// S2 generator-path counters, per docs/LLM-LOOP-DESIGN.md §5; every item is optional or a default-preserving
// widening; CheckpointEnvelope.version stays 1.
```

### 5.2 Members

All tagged `contract 1.9 (Fastlane)` **inside the existing blocks**. Writer discipline in §7.1.

**`StepTiming`** (block at `src/core/types.ts:421`):

```ts
  /** contract 1.9 (Fastlane) §0.4 I3: blocked wall attributable to routers. MUST read 0 — asserted per site and as a bench row. */
  routerWaitMs?: number;
  /** contract 1.9 (Fastlane) §4.4: wall of the fast-path round, the sibling of synthMs */
  fastPathMs?: number;
  /** contract 1.9 (Fastlane) §4.4: Jev latency spent inside the fast-path round */
  fastPathJevMs?: number;
```

**`StepRecord`** (block at `src/core/types.ts:465`):

```ts
  /** contract 1.9 (Fastlane) §4: the fast path's decision and what the round cost */
  fastPath?: StepFastPath;
  /** contract 1.9 (Fastlane) §2: the router table's outcome for this step; bounded at 12 rows */
  router?: StepRouter;
  /** contract 1.9 (Fastlane) §2.4: which verdict actually stood at the risk stage — the audit trail for the ratified polarity change */
  riskSource?: 'code' | 'jev';
  /** contract 1.9 (Fastlane) §2.4: the harm ask was dropped or failed and the code verdict stood */
  jevUnavailable?: boolean;
  /** contract 1.9 (Fastlane) §4.3 T3: scopeUsable() over the step's own test run — recorded even when the fast path is off */
  scopeUsable?: boolean;
```

**The two new shapes:**

```ts
/** contract 1.9 (Fastlane) §4: one fast-path decision. `refused` is NOT `no_passer` (§4.5). */
export interface StepFastPath {
  decision: 'fired' | 'declined' | 'failed';
  /** the clause that declined, or the failure — the per-reason histogram of §8 reads this */
  reason: FastPathReason;
  stage: 1 | 2;
  outcome: 'proposed' | 'no_passer' | 'refused' | 'timeout' | 'error' | 'skipped';
  tRunMs: number;
  sites: number;
  poolSize: number;
  runMode: 'SIEVE' | 'RANK';
  candidatesTested: number;
  testRuns: number;
  jevRequests: number;
  wallMs: number;
  /** the round's CEILING (share + confirm reserve + grace) — the bound R-b tests, and the one the abort enforces */
  budgetMs: number;
  /** the wall share installed on the round's synthesizer */
  shareMs: number;
  passer: boolean;
  confirmedCold: boolean;
  structuralDrops: number;
  /** `GuardFields.held` is `HoldKind | null` — a presence, not a count; the record says so */
  heldAny: boolean;
  dropped: number;
  disarmed: boolean;
}

/** contract 1.9 (Fastlane) §2: the router table's outcome for one step. */
export interface StepRouter {
  issued: number;
  applied: number;
  dropped: number;
  /** I3: MUST be 0 */
  waitMs: number;
  /** `drop` (the finishing pass, review defect A7) is WHY the route did not apply; ABSENT on an applied row */
  rows: readonly { id: string; source: 'jev' | 'code'; appliedAt: number | null; dropped: boolean; drop?: RouteDrop }[];
}
```

`RouteDrop` is `'deadline' | 'error' | 'aborted' | 'committed' | 'empty' | 'work_settled' | 'off'` — the union
`routeSpeculative` already returned and the ledger already threw away. Recording it is what makes §2.2's open
RL2 question answerable from a run directory rather than from a new experiment: `dropped: true` alone cannot
distinguish "this site's deadline is too short for this site's batch" (resize the constant) from "Jev was down"
(I1 did its job), and the two call for opposite actions. It changes nothing with the routers off, where
`record.router` is absent entirely.

`FastPathReason` is a **string union**, not a free string, so the decline histogram of §8 is exhaustive:
`'off' | 'not_jev_on' | 'no_synthesizer' | 'no_parsed_run' | 'scope_unusable' | 'all_passing' | 'workspace_changed' |
't_run_too_slow' | 'multi_file' | 'too_many_failures' | 'repository_class' | 'no_wall' | 'fingerprint_seen' |
'attempts_exhausted' | 'disarmed' | 'loop_tripped' | 'pause_pending' | 'lease_conflict' | 'warm_plane' | 'oracle_class' |
'too_many_sites' | 'pool_exceeds_run_budget' | 'no_sites' | 'empty_step_budget' | 'confirm_timeout' | 'held' | 'error'`.

**`StepProposer`** (`src/core/types.ts:526`) widens:

```ts
export type StepProposer = 'synth' | 'generic' | 'fastpath';
```

Verified safe: no reader outside `engine.ts` and `core/types.ts` (grep).

**`LastTestRun`** (`src/core/types.ts:1066`):

```ts
  /** contract 1.9 (Fastlane) §4.3 T5: the run's wall, so the fast-path predicate survives a resume */
  durationMs?: number;
```

**`StepVerifySummary`** (slot A): `ttfbMs?: readonly number[]`, `hedges?: number`, `hedgeWins?: number`,
`cacheRead?: number`, `cacheWrite?: number`, `cacheHitRate?: number`, `cacheInput?: number`.

**`EngineOptions`** (block at `src/core/types.ts:1514`):

```ts
  /** contract 1.9 (Fastlane) §0.3: the bounded sieve round; default 'auto' in jev-on, 'off' elsewhere. Env: JEVCODE_FASTPATH */
  fastPath?: 'auto' | 'off';
  /** contract 1.9 (Fastlane) §0.3: speculative routers; default 'off' on main, 'on' only in the bench arm. Env: JEVCODE_ROUTERS */
  routers?: 'on' | 'off';
```

### 5.3 Events — none added (I10)

`EngineEvent` is **untouched**. The `synth` event (`src/core/types.ts:1833`) is
`{ type: 'synth'; step: number; phase: string; detail: string; candidates?: number; tested?: number }` and its
`phase` is verified free-form `string`. The fast path and the routers emit through it:

| phase | detail | fields |
|---|---|---|
| `fastpath:considered` | the stage-1 verdict | — |
| `fastpath:entered` | the budget | — |
| `fastpath:declined` | the reason | — |
| `fastpath:passer` | the candidate | `candidates`, `tested` |
| `fastpath:confirmed` | the cold confirm | `tested` |
| `fastpath:abandoned` | the reason | — |
| `router:issued` / `router:applied` / `router:dropped` | `<id> <source>` | — |

The convention is documented at `core/types.ts:1833` in the same commit. The event union, the checkpoint replay,
the plain renderer and every TUI consumer are entirely untouched.

### 5.4 `StageName` is NOT widened

The fast path runs **inside** the `propose` stage, so stage failures, the TUI's stage strip and the CLI surface
are untouched, and no new `PausePoint.phase` value exists.

### 5.5 The bench bridge — the fix no design had

**`src/bench/step-records.ts` is the only bridge from `steps.jsonl` to `BenchRecord.synth`.** `StepsSummary`
(`src/bench/types.ts:97`) is built by `emptyStepsSummary()` / `addStepRow()` (`step-records.ts:18`, `:25`),
summarised at `:50`, read at `:61` and merged at `:71`, and it lands on `BenchRecord.synth` (`types.ts:132`).
Both `experiments/fastlane/quick-table.mts:rowsFrom` and `experiments/llm-jev/headtohead.mts` read
**`tasks.jsonl`**.

Without extending `StepsSummary` and `addStepRow`, **every `fastPath` and `router` field is written to the run
directory and is invisible to every bench table.** `StepsSummary` gains:

```ts
  /** contract 1.9 (Fastlane) §5.5 */
  fastPath: {
    considered: number; fired: number; declined: number; failed: number;
    proposed: number; refused: number; timeouts: number;
    reasons: Record<string, number>;      // the per-reason decline histogram
    stage1Held: number; stage2Declined: number;   // stage1Held = rows recorded at `stage: 2` (see §8.3 R-c)
    candidatesTested: number; testRuns: number; jevRequests: number;
    wallMs: number; budgetOverruns: number;
  };
  routers: { issued: number; applied: number; dropped: number; maxWaitMs: number };
  risk: { codeVerdicts: number; jevUnavailable: number };
```

`addStepRow` folds each step's members in; `mergeStepsSummaries` sums them and takes the max of `maxWaitMs`.
**This is slot D's, and it is required, not optional.**

`experiments/harness-next/quick.mts` `ring2()` **hardcodes `--conditions llm-jev`** at line 333 (and `:269`).
If Ring-2 rows are meant to show `fastPath` at all, that argument must become the arm under test — otherwise the
rows read zero for a reason that has nothing to do with the fast path.

---

## §6 Corner-case matrix

| # | situation | what happens | why it is safe | recorded as |
|---|---|---|---|---|
| 1 | **Jev 503 mid-route** | `routeSpeculative` collapses the throw onto the deadline branch: `dropped: true`, code order stands, step proceeds, `consecutiveStageFailures` **untouched** (I5) | every routed site's code fallback is sufficient alone; RL3 falls back to the code verdict | `router.dropped`, a `jev.jsonl` error row, `riskSource: 'code'` |
| 2 | **Full Jev outage for a whole run** | the run completes on code order, code risk, code completion and code directives | this is the fix for the three dead runs (`sympy-17139`, `django-15128`, `django-15315`) | `routerWaitMs` 0, `jevUnavailable` on the risk steps |
| 3 | **Generator 429 mid-hedge** | a 429 on either leg cancels only that leg; the round succeeds on the survivor. Both legs 429 → the existing propose retry (`PROPOSE_MAX_ATTEMPTS = 2`), then the existing stage failure | `Retry-After` honoured once per leg, never doubled; the hedge budget is shared, not per-leg | `hedges`, `hedgeWins`, and the cancelled-leg cost still reaches `generator.jsonl` via `flushGeneratorRecords` |
| 4 | **Fast-path passer fails the cold confirm** | `isPlausible` never yields a `commit`; if the confirm run itself times out inside the reserve the facade returns `{kind:'failed', reason:'confirm timeout'}`, **disarms**, marks the T10 fingerprint, and the LLM proposes | no unconfirmed patch ever reaches `draft.proposal` | `outcome: 'refused'`, `confirmedCold: false` |
| 5 | **Fast path on a repository** | refused **three** times: T8 at stage 1, `oracleClass !== 'quixbugs_class'` at stage 2, and `decideRunPlan → RANK` at stage 2 | this is the `sympy-16792` shape; repository rounds also route through `runRepositoryQueue` (`src/synth/oracle/verify.ts`), a path this design does not claim to cover. Without T8 the synth's own `rebaseline` would fire a full-suite run of up to `REPO_BASELINE_TIMEOUT_MS = 300_000` inside a ≤ 45 s share | `reason: 'repository_class'` or `'pool_exceeds_run_budget'` — a **counted** decline, not a silent no-op |
| 6 | **Loop detector trips** | the detector is code and evaluates at step boundaries, so it cannot fire mid-round. On the next step T12 keeps the fast path out and the step opens at `replan`, as `jev-on` does today. A trip whose signature is a repeated fast-path patch additionally **disarms** the fast path | RL6 may re-order the directive but cannot stop the run; T10 is **not** cleared by a replan, because the same cluster against a monotone `mem.tried` would enumerate nothing | `reason: 'loop_tripped'`, `disarmed: true` |
| 7 | **Pause point lands inside a round** | the round IS a propose stage — `this.stage('propose', …)` wraps it, so it emits one matched `stage:start` / `stage:end` pair, holds `currentStage` for its whole length and records a `stepTimeline` span (stage 1 stays outside: a decline must cost nothing and emit nothing, and a step whose round fired and declined has two matched propose spans, the round's and the LLM's). It runs under `AbortSignal.any([ctx.signal, timeout])`, so a `human_pause` aborts it exactly like any in-flight propose: `searchSubGoal` returns on `ctx.signal.aborted`, lanes are torn down by the engine's layer-4 `sandbox.killAll()`. The partial round is **discarded**, never cached as a replayable proposal | no new pause point and no new `PausePoint.phase`, because the fast path is not a stage | `outcome: 'error'`, `wallMs`, `interruptedAt: { stage: 'propose' }` |
| 8 | **Resume after a process restart** | `lastTestRunOutput` is in-memory only, so the predicate **cannot arm** until the next verification run — which is correct. `LastTestRun.durationMs` survives, so T5 is evaluable as soon as one does | the round is not resumed; the fingerprint is re-evaluated from scratch and `mem.tried` is fresh | `reason: 'no_parsed_run'` — recorded, never silent |
| 9 | **Coordination lease conflict** | the round itself edits nothing in the workspace (candidates apply under `<runDir>/lanes/laneN`), so no lease is needed to **search**. The returned proposal goes through the unchanged coordinate micro-stage and `checkBudgets` at `engine.ts:3986–3998` | T12 additionally declines to arm when a conflict on the implicated file is already known, so the round's wall is not spent on a patch that cannot land | `reason: 'lease_conflict'` |
| 10 | **Lanes are invisible to a peer** | a fast-path round's lanes write under `<runDir>/lanes/`, outside the workspace and outside the lease | correct (they are shadow copies), but it means a round is invisible to a peer's conflict view until the patch is proposed | — (named, not recorded) |
| 11 | **The ledger claims a commit the engine never executed** | the synthesizer records a commit when it **proposes**. If risk blocks, a human declines, or the apply fails, `patchNotExecutedLastStep(window)` + `rollbackUnexecutedPatch` undo it — but only on the **next** fast-path entry. If the fast path is never re-entered the stale record survives to run end and is dropped by `dropMemory(runId)` | bounded and harmless (nothing outside the synth memory reads that ledger in `jev-on`), **provided** the facade calls `observeWindow` on **every** step of an armed run (§4.6) | — |
| 12 | **Second fast path on the same cluster** | `mem.tried` is monotone, so the second round enumerates nothing. T10 and T11 make it unreachable rather than merely fast | three mechanisms take hashes back out (`forgetUnchangedTried`, `requeueScreened`, a re-baseline) and the facade assumes none of them ran | `reason: 'fingerprint_seen'` / `'attempts_exhausted'` |
| 13 | **`emptyStepBudget` trap** | cannot occur: the fast path calls the public `synthesize()`, so `rebaseline` installs `mem.stepBudget` (`search/index.ts:1262`) | a caller entering at `searchSubGoal` would get `exhausted: () => true` (`memory.ts:164`) and an instant `{kind:'budget'}` indistinguishable from an honest decline | the facade's **first unit test** asserts `candidatesTested > 0` on a known-solvable cluster |
| 14 | **Narrow test command reads green** | T3 applies `scopeUsable` to the engine's own last test run before the fast path trusts it; the record carries the verdict the TRIGGER saw (snapshotted into the draft at propose time), because this step's own run replaces it before the row is written | closes the hole **for the trigger**; the same hole in the **judge** remains and is deferred with an owner (§9.1). **As built, corrected 2026-09-22 (`d297b29`):** §5.2 asked for the member on every step, and I2 — `fastPath: 'off'` is byte-identical to today's `jev-on` — forbids a new row on a step that today writes none. I2 wins, so **the member is written only on an ARMED step** (`src/loop/engine.ts:5651`, inside the `draft.fastPath !== null` guard; the sentence is `src/core/types.ts:580–587`): the bench arm carries it and a `--fast-path off` run's `steps.jsonl` is unchanged. Writing it unconditionally is NOT the fix for the judge hole — it would break I2 | `scopeUsable: false`, `reason: 'scope_unusable'` — on armed steps only |
| 15 | **Two concurrent fast paths in one process** | ~~`runFactsRef` (`src/synth/index.ts:83`) is process-global and read after awaits~~ — **struck 2026-09-22 (`d297b29`): the ref is gone.** The facts are a per-`runId` registry (`src/synth/introspect/facts.ts`, `RUN_FACTS_MAX = 8`, LRU), so two fast paths in one `src/bench/runner.ts` process cannot cross facts | the hazard this row existed for is closed in code, at `c7ae106` | **the `jev-on-next` arm still runs at `--concurrency 1`**, asserted by slot D — now purely a measurement-noise choice, no longer a correctness pin |
| 16 | **A late router answer after step commit** | `token.valid === false` → recorded `dropped`, applied nowhere (I4) | the only concurrency this wave introduces | `router.dropped` |
| 17 | **Both the LLM proposal and a fast-path round succeed** | cannot happen: R9 is a branch route, not a race. The predicate is evaluated before the generator call; when it holds the round runs first and the generator is called only if the round did not commit | prompt assembly (pure, no network) may proceed in parallel — that is the overlap saving | `proposer: 'fastpath'` or `'generic'`, never both |
| 18 | **`fastPath: 'off'` + `routers: 'off'`** | byte-identical to today (I2) | three `if` statements, all false | asserted in slot B's **and** slot C's test files, on the existing `jev-on` goldens |

---

## §7 The four slots

### 7.1 Order, and the two shared files

**Order: B0 → C → D → B → A.** (Grafts: judge 1 §8, judge 2 §7.)

The inversion is deliberate. An A-then-B-then-C order lands the routers — and with them `jev-on`'s changed stop,
risk and completion semantics — **before any evidence that the fast path is worth the wave**. C + D alone produce
a measurable arm with no router work; B and A are then measured as **deltas on the same arm**, each adding a
paired in-session contrast rather than a fresh session that drifts.

**B0** is a prerequisite commit owned by slot B and containing **only** the contract 1.9 header line of §5.1. The
hard rule is that the S4 slot inserts the header; landing it as its own commit before C starts satisfies that rule
*and* the C-first order, and leaves no window in which a tagged member exists without its header.

**`src/core/types.ts` — writer discipline** (graft, judge 2 §6). Only slot B writes the header (in B0). A, C and D
add members **inside existing blocks** and touch no other line. Ordered writers: **B0 (header) → C (fast-path
members, `StepProposer`, `LastTestRun.durationMs`, `EngineOptions.fastPath`) → B (router members, `riskSource`,
`jevUnavailable`, `EngineOptions.routers`) → A (verify-summary members)**. Four writers in one file is the single
most likely integration failure; the strict order is the mitigation.

**`src/loop/engine.ts` — sequential, never concurrent.** C edits it first (the propose call site, `dropMemory`,
`observeWindow`, the `scopeUsable` record, the step token mint). B edits it second, on a tree where C has merged
(the `askRecorded` router seam, `completeAfter` at `:4514`, the `consecutiveStageFailures` exclusion at `:5039`
and `:5063`). **No two slots hold `engine.ts` at the same time.**

### 7.2 Slot B0 — the contract header (≈ 3 lines)

`src/core/types.ts` — the three-line header of §5.1, inserted after `:16`, nothing else. Gate: `npm run check`.

### 7.3 Slot C — the fast path

**Files (exclusive):**

- `src/loop/stages/fastpath.ts` *(new)* — the stage-1 predicate (T1–T12), the budget arithmetic, the acceptance
  rule, the record builder. Pure where it can be.
- `src/synth/search/fastpath.ts` *(new)* — the facade: the lazy per-`runId` `createSynthesizer({mode:'jev-only'})`,
  the stage-2 predicate, the abort ceiling, the `commit` → `Proposal` acceptance, the `GuardFields` surfacing,
  `observeWindow`, its own clock diff.
- `src/synth/search/index.ts` — **≈ 6 lines only**: `ControllerOptions.fastPath` and the `freshBudget` clamp
  (§4.4). Lands in C's **first** commit, before any other synth work on the branch.
- `src/loop/engine.ts` — the guarded branch in the propose dispatch's final `else` (near `:3906`); `dropMemory(runId)`
  at run end beside `sandbox.killAll()`; `observeWindow` every step of an armed run; the `scopeUsable` record on
  every step; the step-token mint and invalidation; `LastTestRun.durationMs` written where the test run is parsed.
- `src/core/types.ts` — `StepFastPath`, `FastPathReason`, `StepTiming.fastPathMs` / `fastPathJevMs`,
  `StepProposer 'fastpath'`, `LastTestRun.durationMs`, `EngineOptions.fastPath`, `StepRecord.fastPath` /
  `scopeUsable`. Inside existing blocks, tagged `contract 1.9 (Fastlane)`.
- `test/unit/loop/fastpath.test.ts`, `test/unit/synth/search/fastpath.test.ts`.

**Gates (all must be green before C merges):**

1. `npm run check` — typecheck, `node scripts/no-any.mjs`, `node scripts/jev-contract.mjs`, lint.
2. `npm test` — the full unit suite (the `--maxWorkers=3` bound lives in `vitest.config.ts`, so the short command carries it).
3. **The facade's first unit test asserts `candidatesTested > 0`** on a known-solvable cluster (§6 row 13).
4. **I2 golden**: `fastPath: 'off'` on the existing `jev-on` fixtures is byte-identical.
5. `fastPath.wallMs <= budgetMs` (the round's CEILING, §4.4) on every fired step in the test fixtures, asserted on a
   round with a real slow baseline rather than on a hand-built telemetry literal.
6. **Ring 1 re-measured green under `--jev off`** — a **hard merge gate** (see §7.7). The code fix landed at
   `0d61eef`; the measurement has not been taken.
7. `node scripts/check-pack.mjs` at the 3.5 MB unpacked gate — re-measured 2026-09-22 at 0.5.0: unpacked
   3,072,489 (87.8 % of the cap), tarball 1,039,272, bundle 2,854,378 minified.

### 7.4 Slot D — bench and measurement

**Files (exclusive):**

- `src/bench/conditions.ts` — `jev-on-next` and `jev-on-next-nofast` as the 7th and 8th `CONDITION_ORDER` rows
  (currently `['jev-on','jev-off','jev-only','llm-jev','llm-sieve','jev-off-tuned']`, `:25`);
  `engineModeOf → 'jev-on'`; `usesSynthesizer` **false** (the fast path builds its own);
  `pinnedGeneration` = the `jev-off-tuned` object plus the S2 hedge/prefix fields; `buildEngineOptions` (`:241`)
  sets `fastPath` and `routers` per arm. `isBenchCondition` (`:79`) and `--conditions` parsing (`:92`) are
  data-driven off `CONDITION_ORDER`, so **no CLI change**.
- **`src/bench/step-records.ts`** — `StepsSummary` extension and `addStepRow` / `mergeStepsSummaries` folding
  (§5.5). **Required.**
- `src/bench/types.ts` — the `StepsSummary` members.
- `src/bench/metrics.ts`, `src/bench/report.ts` — the new columns.
- `src/bench/runner.ts` — arm plumbing and the `--concurrency 1` assertion for the two new arms.
- `experiments/harness-next/quick.mts` — Ring-2 rows for `routerWaitMs`, `fastPath.*`, `ttfbMs`, **and the
  `--conditions` argument at `:269` and `:333`**, which today hardcodes `llm-jev`.
- `experiments/fastlane/quick-table.mts` — the fast-path columns in `rowsFrom`.
- `experiments/llm-jev/headtohead.mts` — the new arms.
- `docs/HARNESS-NEXT-DESIGN.md` (§3.x table, the C2 `:864`/`:1617` correction, §6 S2/S4 as-built),
  `docs/STATUS.md`, `docs/DECISIONS.md` (the §2.4 ratification row and the wave record), `CHANGELOG`.

**Not** `src/bench/cli.ts` (slot A's `--quick`). Note that `src/bench/summary.ts` **does not exist** —
`summary.json` is written by `runner.ts`, and the column chain is
`step-records → types → metrics → report`.

**Gates:** `npm run check`; `npm test` (the unit project bounds itself to 3 workers); a dry-run of `quick-table.mts` and `headtohead.mts`
over a recorded run directory showing the new columns non-empty; the `--concurrency 1` assertion firing.

### 7.5 Slot B — the routers

**Files (exclusive, on a tree where C has merged):**

- `src/jev/router.ts` *(new)* — `routeSpeculative`, `ROUTER_DEADLINE_MS`, `RouterId`, `StepToken`.
- `src/jev/danger.ts` *(new)* — `dangerousCommand()`, the promoted deny-list (§2.4).
- `src/jev/mock.ts` — re-export only, so the mock decider is byte-identical.
- `src/jev/off.ts` — router-aware escapes; the `:21` comment updated to point at `danger.ts`.
- `src/loop/stages/{intent,context,judge,complete,replan,risk}.ts` — the six conversions and their four-clause
  blocks (§2.3).
- `src/synth/oracle/scope.ts` *(new)* — RS1.
- `src/synth/search/subgoal.ts` — RS2 (`:156`), RS3 (`:763`), RS4 (`:864` and `:1617`).
- `src/loop/engine.ts` — the `askRecorded` router seam; `completeAfter` (`:4514`); the
  `consecutiveStageFailures` exclusion (`:5039`, `:5063`).
- `src/core/types.ts` — `StepRouter`, `StepTiming.routerWaitMs`, `StepRecord.router` / `riskSource` /
  `jevUnavailable`, `EngineOptions.routers`.
- `scripts/jev-contract.mjs` — the five loop allow-list rows deleted or tightened (`intent.ts`, `context.ts`,
  `risk.ts`, `judge.ts`, `replan.ts`), plus `subgoal.ts` tightened.
- `test/unit/jev/router.test.ts`, `test/unit/jev/danger.test.ts` (table-driven),
  `test/unit/loop/router.test.ts`, `test/unit/loop/stages/**`, `test/unit/synth/search/router.test.ts`.

**Deferred to slot B's post-C commit, and only that commit** (§7.1: no two slots hold `src/loop/engine.ts` at
once, and slot C held it while slot B landed). **All five landed at `c811899`** (branch `llm-loop-seam`, on the
integration tip `13414f0`); the consequence column is the state the wave lived in until then, kept because the
"as built" note below is only readable against it.

| what | consequence until it landed | landed |
|---|---|---|
| a per-call signal on `ctx.ask` / `askRecorded` | a dropped router ask is cancelled at the router but still runs to completion inside `askRecorded`, charging its metering, `jev.jsonl` row, `decision` events and persists to the step that issued it — after that step's `StepRecord` was written (review 2026-09-22, defect 2) | **landed at `c811899`** — `StageContext.ask` takes a 5th optional `signal`; `askRecorded` links it with the run signal AND abandons the call at a guard after the await |
| `EngineOptions.routers` → `routersOn(ctx.mode, opt)` | the switch a bench arm can express is `JEVCODE_ROUTERS=on` per worker process (defect 3) | **landed at `c811899`** — `makeContext` → `StageContext.routers` → the four routed sites; and **both** mechanism switches inverted so the explicit option beats the env (see (b) below) |
| `commitStepRouters` in the `StepRecord` finally | `StepTiming.routerWaitMs`, `StepRecord.router`, `riskSource` and `jevUnavailable` have no writer: the §5.2 audit trail and the I3 bench row do not exist in a real run, and a step's ledger is reclaimed by the live LRU (defect 9) | **landed at `c811899`** — at the head of `Engine.commit`, behind the switch; `discardStepRouters` on the §9.1 rule-1 path |
| `completionDecision` at `completeAfter` | RL5 is written and unit-tested; no run reaches it | **landed at `c811899`** — routers-on only; in `jev-on` `hasEvidence` is false on every step today, so the Jev branch runs and I2 holds (§2.5) |
| the retry waker keyed per in-flight request | an abandoned router ask can still clobber the shown `retryWaker` / `retrying` slot (review defect 6 of the engine set, unconfirmed) | **landed at `c811899`** — CONFIRMED by a test and fixed: each call holds its own controller and clears the shared slot only while it owns it |

The five members are no longer **RESERVED** in `src/core/types.ts`: each names its writer instead.

**Gates:**

1. `node scripts/jev-contract.mjs` green **with the rows removed** — the ratchet is two-sided (I11).
2. One named throwing-`Decider` test per routed fallback, and the test name appears in the site's clause-3 text.
3. `routerWaitMs === 0` asserted per site.
4. The late-write test (§2.6).
5. Router failures do not advance `consecutiveStageFailures` — asserted with three consecutive throwing asks and
   a run that does **not** stop.
6. **The `docs/DECISIONS.md` ratification row for §2.4 exists and is merged.** B does not land without it.
7. **I2 golden** under `routers: 'off'`; and a **re-captured** `jev-on` golden under `routers: 'on'`, with the
   header saying which capture is which.
8. **Ring 1 re-measured green under `--jev off`**, and the `src/synth/localize/index.ts` allow-list row
   (`jev-contract.mjs:48`) justified by that run or replaced — a hard merge gate (§7.7).
9. `npm test`, `npm run check`.

#### 7.5a The engine seam, as built (`c811899`, 2026-09-22)

Five things the deferral table did not say, each one a thing the rows above left implicit and the seam therefore
had to decide. They are the normative reading of §2.1 clause 6, §2.6 and §0.3 from here on.

1. **The per-call signal is a belt AND a guard.** Aborting the linked controller is a *request*: an in-process
   decider, a client mid-parse or a cache hit can all answer anyway. So `askRecorded` links the caller's signal
   with the run's (the request really is cancelled) **and** re-reads `signal.aborted` after the await: an answer
   that arrived for a caller who has gone is **abandoned** — no meter, no `jev.jsonl` row, no `decision` event,
   no `draft` mutation, not even `jevWallMs`. It rejects with the reason the caller gave, which
   `routeSpeculative` already catches into its one drop branch. The stages keep their `routed?.valid === false`
   check in the annotate callback: that is the one drop the signal cannot see (an answer landing after commit
   under a signal nobody aborted).
2. **The explicit option beats the environment, in both mechanisms.** §0.3 said "an env override"; slot D found
   that `routersEnabled` ORed `JEVCODE_ROUTERS=on` in and `resolveFastPathOption` read `JEVCODE_FASTPATH`
   *first, in both directions*. An arm's own `summary.json` row was therefore not the truth: an exported switch
   armed `jev-on-next-nofast` or disarmed `jev-on-next` with nothing in the output to show it. Both now read the
   option first and fall back to the env only when the caller pinned nothing — the `jev-on` gate still ahead of
   both. `pinMechanismEnv` stays as the belt for a worker that pins nothing.
3. **`commitStepRouters` is behind the switch, and that is load-bearing.** It closes a `(runId, step)` key
   whether or not a router ran (defect 6's fix), and a closed key hands out a permanently-invalid token. A
   routers-**off** run that closed `(runId, 1…n)` would disarm every router of the next run in the same process
   that reused the run id — which is exactly what an A/B over one fixture is. `router-golden.test.ts`'s
   routers-on case caught it. Off, the seam is not entered at all.
4. **A discarded step is not a committed step.** §9.1 rule 1 replays the same step number, so `commitStepRouters`
   there would drop every router of the replayed attempt `committed` before it was issued. `discardStepRouters`
   invalidates the attempt's token and deletes its live state while leaving the key **open**.
5. **RL5 is wired and unreachable, exactly as §2.5 predicted.** `completeAfter` calls `completionDecision` only
   with the routers on, and passes `hasEvidence = draft.proposal?.evidence !== undefined` — false on every
   `jev-on` step until route R9 commits its first fast-path proposal. So the routers-on arm completes on Jev's
   Noul today and `router-golden.test.ts` passes unchanged; the behaviour change lands with R9, not with this
   commit.

Also landed here, from slot A's list: **defect 11**. `noteSampleEnd` drops `generatorBatch.inFlight` to 0 in
`generate`'s own `finally`, before the source's `handleEnd` / `settle` has marked the origin served and cleared
its hedge timer — a twin started in that window found `inFlight === 0` and opened a **second round for one
batch** (contract 1.4 §12.0.2 P3), so `PausePoint.llmRound.round` named a round the synthesizer never ran and
the batch wall restarted mid-round. CONFIRMED at the engine seam by a test that fires a twin in that window and
reads the pause cache. `noteSampleStart` now takes the sample index and `hedgeOriginOf()` decides: a twin takes
the open batch's wall and never the round counter; every other index is unchanged, so the PausePoint contract
tests read what they read before. **Not** confirmed as reachable through today's `src/synth/llm/source.ts`
wiring: every path from the engine's `finally` to `settle`'s `clearHedgeTimer` is microtask-only
(`generateWithDeadline`'s `.then/.finally`, `handleEnd`'s non-result branch has no `await`, and its result
branch calls `st.served.add(k)` before any), and a `setTimeout` cannot interleave with a microtask chain. The
guard is therefore a structural fix for a real engine-side hole rather than a fix for an observed run.

#### 7.5b RL2, as built (the finishing pass, F27)

Slot B's list above names `context.ts` among the six conversions, and its allow-list bullet names the
`context.ts` row among the five to delete. **Neither happened**: the six conversions landed as five, the context
stage kept its inline `await ctx.ask('context', …)` and its allow-list row, and so **I1 was not true end to
end** — with `routers: 'on'` a Jev 503 at the context stage still rejected the stage and ended a
`jev-on-next` run, which is precisely the failure the wave exists to remove (the head-to-head lost
`sympy-17139`, `django-15128` and `django-15315` to exactly this shape).

As built now:

- the ask is a `routeSpeculative<CandidateView[]>` with `id: 'RL2'`, `RL2_CONTEXT_DEADLINE_MS` (400 ms), the
  step signal, the §2.6 step token and the §7.5a per-call signal; its drop is folded into the step's ledger
  through `noteStepRoute` → `commitStepRouters`, so a dropped context ask is a `StepRecord.router` row and not
  an error;
- **the code order is `selectCandidatesCode(views)`** — the pre-filter order with the files this run TOUCHED
  first, under the same 12-file / 60 KB caps. It is *not* `selectCandidates(views, new Map())`: with no answers
  every probability defaults to 0, below the 0.5 threshold, so the "code selection" would be the empty
  selection — Jev withholding every candidate by being unreachable, the exact shape I1 forbids. Touched-first is
  what makes §2.2's "traceback frames and changed files are always members" true when the 12-file cap bites;
- **the ANSWERED path is unchanged**: when Jev answers inside the deadline the selection is still
  `p >= 0.5` descending under the caps, byte for byte what the inline ask produced. RL2 changes what happens
  when Jev does *not* answer, and nothing else;
- with the routers **off** the stage is the pre-1.9 stage: one `if`, false — no token is minted, no key is
  opened (I2's half of the switch, pinned in `test/unit/loop/router.test.ts`);
- `scripts/jev-contract.mjs`'s `src/loop/stages/context.ts` row is **deleted** and the site carries the
  four-clause block of §2.3 (the ratchet is two-sided, so the row could not merely be left behind).

**Open against RL2 (review defect A7): its 400 ms deadline is measured on a different batch.** RL2 sends the
loop's LARGEST ask — one Noul per candidate, up to 300 — against a figure derived from the loop's asks in
general, so it may be an off switch rather than a deadline. The reason for each drop is now recorded on the
row (`StepRecord.router.rows[].drop`), so the first `jev-on-next` run answers the question from its own
`steps.jsonl`; see §2.2 for the reading rule and for why `dispatch` is not the alternative it looks like.

### 7.6 Slot A — the S2 generator path

**Files (exclusive):** `src/provider/sse.ts`, `src/provider/types.ts`, `src/provider/http.ts`,
`src/provider/{anthropic,openai-compat,openrouter}.ts`, `src/provider/prompts.ts`, `src/provider/generate.ts`,
`src/synth/llm/source.ts`, `src/synth/llm/prompt.ts`, `src/synth/search/llm.ts`, `src/bench/cli.ts` (`--quick`
only), `src/core/limits.ts` (additive), `src/core/types.ts` (the `StepVerifySummary` members),
`test/unit/provider/**`, `test/unit/synth/llm/**`.

**Gates:** `npm run check`; `npm test` (the unit project bounds itself to 3 workers); the `view: 'legacy'` prompt golden — **unchanged, or
the change is stated and the golden re-captured with a reason** (§3.3); a budget-refusal test proving a hedge is
declined when the budget cannot hold one more estimated-full-cost sample; cancelled-leg cost still reaching
`generator.jsonl`.

#### 7.6a S2 on the `jev-on` propose path, as built (the finishing pass, F25)

Slot A built all four S2 mechanisms **inside `src/synth/llm/source.ts`**, which `jev-on` never enters. So the
`jev-on-next` arm recorded `mechanisms.s2: true` while, on its own propose call: `PromptInput.prefixOrder` was
never set (§3.3 off), `onFirstByte` was forwarded only on the synthesizer's sample path (§3.1 unmeasured — and
therefore §3.2's threshold had no input), and the hedge and the provider-order rotation belonged to the round
(§3.2 off). The §8.3 S2 row was structurally empty for every jev-on arm, not because nothing happened but
because nothing was wired.

As built now:

- **the switch** is `s2Mode(mode, env)` in `src/synth/llm/hedge.ts` — `jev-on` only and **default off**
  (§0.3's rule for a new mechanism), armed by `JEVCODE_S2=on`. `'partial'` is the honest middle: the §3.1 /
  §3.3 / §3.4 measurement half on and the §3.2 hedge off because `JEVCODE_HEDGE=off` said so, so a hedge
  counter of 0 in a record means "switched off" rather than "nothing was slow enough".
  **Because the default is off, `router-golden.test.ts` was NOT re-captured** and every `view: 'legacy'` prompt
  golden is untouched: an S2-off `jev-on` run is the pre-1.9 run, byte for byte.
- **§3.3** `Engine.promptInput()` sets `prefixOrder: 'pinned'` under the switch. The head — task, then the repo
  map — repeats verbatim across steps whose changed-file lists differ, which is the property the test asserts.
- **§3.1** the propose call forwards `onFirstByte`; the readings feed `Engine.p50TtfbMs()` (with the
  synthesizer's own `LLM_DEADLINE_ADAPT.minSamples` floor, review defect 8) and this step's
  `StepRecord.verify.ttfbMs`. Bounded at `TTFB_READINGS_MAX`.
- **§3.2** `hedgedCall` (`src/synth/llm/hedge.ts`) races the one call: the origin goes out at once, and if it
  has produced no first byte for `hedgeAfterMs(p50)` one twin follows it on the **rotated** upstream order,
  under the twin's own sample index (`HEDGE_TWIN_OFFSET`, which `hedgeOriginOf` reads back). The first result
  wins, the loser is aborted and **booked** through the same estimator the synthesizer's loser uses
  (`recordUnfinishedSample`), so both legs reach `generator.jsonl`: a hedge is faster, never free. A leg that
  REJECTS while the other is live is not the call's answer, so a hedged call is never less reliable than an
  unhedged one.
- **§3.4** the provider's `cacheReadTokens` / `cacheWriteTokens` are summed per step onto
  `StepRecord.verify.cacheRead` / `cacheWrite`. `src/bench/step-records.ts` already folds all five members off
  `steps.jsonl` into `StepsSummary.s2`, so the §8.3 row needed no bench change.
- **`EngineStatus.mechanisms: { s2, routers, fastPath }`** (optional, additive) is the engine's own answer about
  what it resolved, as against `ConditionConfig.mechanisms`, which records what an arm intended.

**What the shared helper is, exactly.** `src/synth/llm/hedge.ts` owns the DECISION half of §3.2 / §3.4 — the
threshold, the twin index, the rotation, the reasoning-cap composition, the switch — and `source.ts` imports and
re-exports every one of them unchanged (its behaviour is byte-identical; `test/unit/synth/llm/hedge.test.ts`,
`source.test.ts`, `cache-and-reasoning-cap.test.ts` and `test/unit/provider/provider-order.test.ts` are the
pin). What is **not** shared is the round's scheduling: the dollar hold, `samplesLeft`, the heartbeat row and
the arrival ledger have no meaning for a single call, and moving them would have been a rewrite of the round
rather than an extraction.

#### 7.6b The finishing pass's own review (defects A1–A3, A5, A8–A10, and F25's first gap closed)

Ten defects came back against 7.6a. Nine are fixed here; the tenth (A7) is §2.2's RL2 deadline, above.

- **A1 — a hedged call was LESS reliable than an unhedged one, in the commonest drain order.** `hedgedCall`
  filtered its live legs on "has this leg settled" rather than on "is this the leg whose event I just
  consumed". `Promise.race` hands back one event per turn, so a twin that resolved in the same microtask drain
  as the origin's rejection was settled and unobserved when the origin's rejection was taken: the filter
  dropped it, `live` emptied, and the origin's error was thrown over a result already in hand. Two legs of one
  request against one upstream settling together is not a corner case. Legs are now identified by `sample` and
  leave the race only when observed. `test/unit/synth/llm/hedged-call.test.ts` drives the review's probe.
- **A2 — a twin win leaked `hedgeAfterMs` (3–8 s) into `harnessMs`.** Only the winner's provider-reported
  `latencyMs` reached `draft.timing.generatorMs`, and a twin's own latency starts at the hedge threshold, so
  the origin's whole silent wait fell into no named bucket and the commit's residual formula charged it all to
  harness overhead — the metric the 50 ms p95 budget is read against. `generateProposal` now books the RACE's
  wall, exactly as `noteSampleEnd` books a round's batch wall.
- **A3 — a WINNING twin wrote a row `hedgeOriginOf` could not read back, and the step reported itself
  cancelled.** The success row's spread never consulted `leg.sample`, so only the LOSER carried an index and
  only the loser was counted: a jev-on step that SUCCEEDED recorded `samples: 1, cancelled: 1`, and because
  `src/bench/step-records.ts` sums those off any row with a `verify` object, a `jev-on-next` arm with S2 on
  reported a 100 % cancellation rate on an arm with no synthesizer at all. The winner carries its index now,
  and `pushGeneratorRecord` takes a `counts` argument: **the `verify.samples` / `timeouts` / `cancelled` /
  `malformed` tallies are the SYNTHESIZER's round, and a one-shot §3.2 leg is not a member of one.** The legs
  are recorded where they belong, in `hedges` / `hedgeWins`.
- **A5 / F25's first gap, closed.** `EngineOptions.s2?: 'on' | 'off'` exists, `s2Enabled` reads it **before**
  `JEVCODE_S2` (the polarity §7.5a inverted the other two to), `buildEngineOptions` writes it from
  `armMechanisms(condition).s2`, and `MECHANISM_ENV_VARS` gains `JEVCODE_S2` **and** `JEVCODE_HEDGE`. Both
  halves of the gap were live: the arm ran with S2 off while its row said `true`, and an exported
  `JEVCODE_S2=on` armed the whole §3 path on the plain `jev-on` CONTROL arm (`engineModeOf('jev-on')` passes
  `s2Mode`'s mode gate) while that row said `false`. `JEVCODE_HEDGE` rides along because it is the half-switch
  that turns a pinned `'on'` into `'partial'`.
- **A8 — `EngineStatus.mechanisms` was unconditional.** It contradicted its own type doc and added a member to
  every `--json=verbose` status line in every mode, including every control arm. It is a conditional spread now,
  in the same shape as the adjacent `coordination` triple: **absent means all three resolved off.**
- **F25's `state` sub-part.** `CheckpointState.mechanisms` carries the same projection under the same rule, so
  an ARCHIVED run directory can be checked against `summary.json.conditions[arm].mechanisms` without re-running
  it. One `mechanismsMember()` feeds both.
- **A9 — `addStepTimingToRun`'s contract was overclaimed.** `RunResult.timing` is the sum of the committed
  `steps.jsonl` rows **plus the wall of any attempt §9.1 rule 1 discarded** — a discarded attempt writes no
  `StepRecord`, so `absorbDiscardedTiming` adds its buckets to the run directly and the run is legitimately
  larger. That was already true of `decomposeMs` / `generatorMs`; F13 made it true of four more. Comments only.
- **A10 — the two timing builders named different optional sets.** `llmJevTiming` omitted `fastPathMs` /
  `fastPathJevMs` while `absorbDiscardedTiming` reads them for both branches, so a discarded llm-jev attempt
  could contribute fast-path wall a committed one could not (unreachable only because `resolveFastPathOption`
  forces `'off'` outside `jev-on`). There is one builder now, `optionalStepTiming`, and `RUN_TIMING_BUCKETS` is
  its pair; a test asserts they agree.

**One gap remains, and it is a DECISION rather than an omission.** The §3.4 reasoning cap has no `jev-on`
consumer: the loop's propose request carries no `reasoning` parameter, `EngineOptions.generation` is
`{temperature, maxTokens}` and nothing composes a cap onto nothing. `reasoningCapTokens` never RAISES what was
not asked for, so the composition rule is correct and inert here. Giving it a consumer means sending
`reasoning: {maxTokens}` where none was sent — turning reasoning on with a budget for a model that may not have
been reasoning at all. That is a new mechanism under §0.3 (default off, its own arm, its own measurement), not
a wiring fix, and the finishing pass does not add one. `mechanisms.s2` does not lie about it: §3.4's other half
(the `cacheRead` / `cacheWrite` accounting) is wired and measured.

### 7.7 The cross-cutting gate: Ring 1 under `--jev off`

Ring 1 with `JEVCODE_JEV=off` must complete all five tasks.

**The status changed under this document while it was being written**, and the change is favourable. At
iteration 1 the ring was red (`gcd`, `mergesort`, `units` lost) because the localiser returned
`sitesConsidered: 0`. `oos-iter-2` landed the fix at **`0d61eef`** — an escaped Choice now falls through to the
code order rather than to no site at all — with a named unit test
(`test/unit/synth/localize/jev-off-fallback.test.ts`). **It has not been re-measured:** `docs/DECISIONS.md` still
carries the iteration-1 verdict, and iteration 2's own text says it is measured on the same 18 + 28 before any
of it is called an improvement.

So the gate stands, with its content changed from *write a fix* to *produce the measurement*:

- **Before B merges**, Ring 1 under `--jev off` must be **run and green**, and the allow-list row for
  `src/synth/localize/index.ts` (`jev-contract.mjs:48`, still claiming "code order is the fallback") must be
  either justified by that green run or replaced by a four-clause block. The claim is now true in code; the row
  should stop resting on prose.
- **Before C merges**, the same green run, because the fast path routes through that same localiser: with Jev
  off a regression there would make it arm, enumerate nothing and spend its budget — a silent zero-site failure
  that looks exactly like an honest decline, and one that would make the §8 decline histogram lie.
- **Slot C additionally adds its own belt**, independent of the ring: a stage-2 round that comes back with
  `sites === 0` records `reason: 'no_sites'` and **disarms** (§4.5), so even an unfixed or re-broken localiser
  costs one round per run rather than every round.

If Ring 1 does not come back green, the fallback position is Q3's: **C's stage-2 predicate additionally refuses
when the decider is the off-decider**, and the arm ships with the limitation stated. That is a worse outcome and
it must be an explicit decision, not a drift.

### 7.8 Rebase discipline

`main` moves. Every slot branches from **current** `main`, merges `main` before its final gates, and re-runs every
gate on the merged tree. Commits use explicit paths — never `git add -A`, never `git stash`.

---

## §8 Measurement plan and accept rule

### 8.1 Arms

| arm | mode | `fastPath` | `routers` | generation | what it isolates |
|---|---|---|---|---|---|
| `jev-on` (plain) | `jev-on` | off | off | today's default | **the missing baseline** |
| `jev-on-next-nofast` | `jev-on` | **off** | on (after B) | tuned (`s2: off`) | routers, without the fast path |
| `jev-on-next` | `jev-on` | auto | on (after B) | tuned (`s2: off`) | routers + the fast path |
| `llm-jev` | — | — | — | — | **recorded** rows, `experiments/results/llm-jev-iter1.md` |
| `jev-off-tuned` | — | — | — | — | **recorded** rows, same file |

**S2 is NOT on these arms, and the table used to say it was** (F05). Both run `engineModeOf === 'jev-on'`, and every
§3 mechanism lives on the llm-jev sample path: nothing sets `PromptInput.prefixOrder`, `onFirstByte` is forwarded only
from that path, and hedging plus the §3.4 reasoning cap are in `src/synth/llm/source.ts`, which `jev-on` never enters.
`armMechanisms` now clamps a pinned `s2` to `'off'` outside `llm-jev`, `pinnedGeneration` no longer carries the S2
block on these arms, and `measurementRows` carries an `R-s2` row that reads `not_evaluable` with the reason — naming
the arm's own mode, since the function takes any `BenchCondition` (B6). What summary.json records is the OBSERVED
value when a run reports one, never a constant — so wiring S2 onto `jev-on` (F17) cannot make the record wrong in
the other direction either. That observation travels the way every other steps.jsonl fact travels (§5.5):
`StepRecord.mechanisms.s2` → `StepsSummary.s2.state` (unioned, disagreeing steps fold to `'partial'`) → `runner.ts`'s
`conditionConfig(c, opts, model, { s2: observedArmS2(records, c) })` for summary.json AND the `R-s2` row, so the two
read the same member and cannot disagree. `observedArmS2` is `null` — not `'off'` — when no run reported the member,
because "nothing measured it" must not overwrite a pin the way a measured `'off'` does (B4: the runner had no such
call at all, and the raw-row reader it replaces collapsed both cases to `'off'`; that reader is deleted rather than
left beside the wired one, so there is no second copy to leave unwired).

**The `jev-on-next-nofast` control is the single most valuable device in the plan.** Without it a
`jev-on-next` win confounds tuned generation + routers + the fast path. The two arms run as a **paired
in-session contrast**, not as separate sessions that drift.

**The plain `jev-on` arm is a required addition** (graft, judge 2 §10): there are **no recorded `jev-on` rows** in
`experiments/results/` for the fresh slice. Without one cheap `jev-on` run on the fresh 18, nothing can be
attributed to "making `jev-on` primary" — every arm would be compared only to recorded `llm-jev` and
`jev-off-tuned`, and the I2 byte-identity invariant would stay an assertion instead of a measured pair.

**Sequential ablation.** C + D give the first number (`jev-on` vs `jev-on-next` vs `jev-on-next-nofast`, fast path
only). B adds the routers as a **delta on the same arm**. A adds S2 as a second delta. Each wave is a paired
contrast against the arm that preceded it.

### 8.2 Slices and conditions

- **Fresh 18** (untuned) and **in-sample 28**.
- **`JEVCODE_WARM` unset (off)** throughout (I8).
- **`--concurrency 1`** for every arm that can enter the fast path (§6 row 15).
- `--maxWorkers=3` for the unit suite — set in `vitest.config.ts`, so plain `npm test` is the bounded run; the bench's own concurrency is separate.
- `alwaysDecline` confirmer.
- Baselines are **not re-run**: `experiments/llm-jev/results.ts` merges the recorded rows by
  `(suite, task, condition)`.
- **Build-drift caveat, and it is not small.** The recorded `llm-jev` and `jev-off-tuned` rows were taken at
  **`751e3bf`**. `main` is now **`d86c385`** and carries `oos-iter-2` — nine changes including the replan
  escalation (`9a161a1`), the repository `rankPoolCap` (`39de7cb`), the deadline high-water mark (`11f169e`)
  and the localiser fallback (`0d61eef`) — **none of which has been measured**. Comparing `jev-on-next` to
  those recorded rows therefore confounds this wave with all of iteration 2. Two consequences, both binding:
  the **`jev-on-next-nofast` control and the plain `jev-on` arm are the only same-build contrasts in the plan,
  and §8.5 clause 4 rests on the control, not on the recorded rows**; and if `oos-iter-2` is measured on the
  same 18 + 28 first (as its own decision text commits it to), those fresh rows replace the `751e3bf` ones as
  this wave's baseline and the confound disappears. **Prefer that ordering.**
- Every live command runs as
  `env -u ANTHROPIC_API_KEY node --env-file=<repo>/.env …`.
- If `/tmp/jevcode-perf-window-open` exists, nothing starts. **This is now enforced where the load is generated, not
  only here:** `runPerf` (`src/perf/main.ts`, `openPerfWindow` / `closePerfWindow`) refuses to start while a live
  window exists — exit 2, naming the file, when it was taken, by whom and when it goes stale — writes the protocol's
  header line `<iso-8601 created> <pid> <owner-label> <expected-minutes>` for the length of the run, releases it in a
  `finally` (and only if the line still names this pid), and replaces a window past its TTL — `max(expected, 30)`
  minutes, never above 90, from the recorded creation time; a sentinel with no header line keeps the 30-minute floor
  measured from its mtime, so a bare `touch` is honoured rather than clobbered — as a killed run's leftover, with a
  logged note. A measurement arm still has to honour the file by hand, because an arm is a bench command rather than
  a perf run; the half that actually costs the other session its cores no longer depends on anyone reading this
  bullet.

**Cost.** Two (later three) arms × 46 tasks at forced concurrency 1 is the most expensive honest measurement on
offer. It is the price of attribution; a cheaper single-arm run buys a number nobody can interpret.

### 8.3 Rows

Via `experiments/llm-jev/headtohead.mts`, which already gives paired tables, the one-sided exact sign test on
discordant pairs, Wilson intervals, the median-wall Wilcoxon, `$/task` and `$/solved`, and criteria 1–5.

**Five new rows, all blocking:**

| row | source | pass condition |
|---|---|---|
| R-a | `routers.waitMs` p95 over every step | **= 0** |
| R-b | `fastPath.wallMs <= budgetMs` over every step that RAN A ROUND (`stage: 2`), where `budgetMs` is the round's ceiling (§4.4) | **100 %** |
| R-c | stage-2-declined / steps where stage 1 HELD (`stage: 2` rows), per suite | **≤ 0.3**; above that the **predicate** is wrong, not the budget |
| R-d | the per-reason `fastPath.reason` decline histogram on every ineligible step | exhaustive over `FastPathReason`, no `'error'` bucket > 5 % |
| R-e | `riskSource: 'code'` count and `jevUnavailable` count | reported; any step where a *harmful* command was allowed under a dropped ask **reverts the §2.4 ratification** |

**As built, both denominators are the rounds that ran, not the rows marked `fired`.** The writer (§5.2
`declinedRecord` / `firedRecord`) records `stage: 1` only on a free decline and `stage: 2` on every row of a round
that ran, and sets `decision: 'fired'` only on a successful proposal. A "stage-1-fired" count is therefore 0 on
every run the writer can produce: R-c built on it reads `pass … n/a` however badly the predicate is calibrated,
prediction (e) is permanently `not_evaluable` (so the (e) branch of the RETIRE rule can never fire), and a
budget-overrun count keyed off `fired` misses the shape that matters most — a round that blew the 45 s budget and
then timed out or was refused, which is `decision: 'failed'`.

R-c says the predicate is miscalibrated; **R-d says which clause is doing it.** Both are needed: a ratio alone
does not name the mistake.

### 8.4 Pre-registered predictions, with a RETIRE rule

Registered **before** the arms run, in `docs/DECISIONS.md`:

- **(a)** solved ≥ `llm-jev`'s 12/18 on the fresh slice.
- **(b)** median wall on the both-solved tasks **below** `llm-jev`'s 26.0 s and **within 10 %** of tuned's 19.7 s.
  This is the first risk, not a footnote: `llm-jev` is already **1.32× slower** than tuned on the 8 both-solved
  QuixBugs tasks, and a losing fast path deepens exactly that shape. A 45 s budget spent on a task the generator
  would have solved in 20 s is a **2× regression**.
- **(c)** the ladder long-2 tier keeps ≥ 3/6.
- **(d)** `routerWaitMs` p95 = 0 on every step.
- **(e)** `fastPath.decision === 'fired'` **and** `outcome === 'proposed'` on **≥ 60 %** of the QuixBugs steps
  where stage 1 held.
- **(f)** `jev-on-next` − `jev-on-next-nofast` on solve count is **> 0** on the fresh 18, or the fast path is not
  the reason for any win the arm shows.

**RETIRE, do not tune** (grafts, judge 1 §11 and judge 2 §3). A failure of **(a)** or **(e)** **retires route R9**;
it does not loosen the predicate. The predicate is structural precisely so that a null result is *interpretable*
rather than an invitation to widen the gate until something fires. Paired with R-c and R-d, both a null result and
a mis-tuned trigger are publishable.

A failure of **(b)** with (a) holding is the one case that permits a *narrowing* retune — lowering
`FASTPATH_WALL_MAX_MS` or `FASTPATH_MAX_T_RUN_MS` — never a widening.

### 8.5 Accept rule

The wave is accepted when **all** hold:

1. Every gate in §7 is green on the merged tree, including Ring 1 under `--jev off`.
2. R-a and R-b pass. R-c passes on every suite, or the predicate is revised and the arms re-run.
3. Prediction (a) holds **and** (b) holds.
4. (f) holds, i.e. the paired control attributes the win to the fast path — **or** (f) was EVALUATED and lost while
   the fast path is retired under §8.4, and the wave ships as **the routers alone** with `fastPath` defaulted `'off'`
   in every mode. As built, the escape requires an evaluated (f): "the control never ran" is `not_evaluable`, never
   a pass — a retired R9 does not substitute for the contrast, or "ship the routers alone" is a hope rather than a
   measured statement. The escape used to name the §3 generation path alongside the routers; after F05 no arm of
   this plan runs it, so that wording authorised shipping an unmeasured mechanism on the strength of a measured one.
   The §3 path ships with F17 (§9.1), on an arm whose mode can reach it and against its own measurement.
5. R-e's `riskSource: 'code'` and `jevUnavailable` counts are **reported** for the §2.4 judgement. As built this
   clause carries NO machine condition: whether a harmful command was allowed under a dropped ask is read off the
   steps by a person. If one was, §2.4 is reverted and slot B's risk change is backed out independently of the rest.

**The default-mode flip to `jev-on` is not part of this accept rule.** It is a separate decision on these rows.

---

## §9 Open questions for the owner, with defaults

Each has a default the implementer follows if the owner says nothing. Nine questions; the first three are the ones
that change the shape of the wave.

**Q1 — Does §2.4 (the risk polarity change) get ratified at all?**
It contradicts a ratified invariant: `docs/HARNESS-NEXT-DESIGN.md` §1.2 and the `jev-contract.mjs:34` allow-list
row both say a failed Q20 means **ask, never allow**. The wave proposes that a dropped harm ask leaves the
**code** verdict.
**Default if unanswered: NO.** Slot B lands RL1, RL2, RL4, RL5, RL6 and RS1–RS4, and **leaves `risk.ts`
unchanged**. A Jev outage then still forces an ask at the risk stage — which costs I1 at exactly one site and is
the conservative reading. `riskSource` and `jevUnavailable` are still added, so the data exists for a later
ratification. Nothing else in the wave depends on this.

**Q2 — Is `routers` off-by-default on `main` permanent, or does it flip after the head-to-head?**
**Default: off until §8.5 accepts, then a separate one-line decision recorded in `docs/DECISIONS.md`.** Do not
bundle the flip with the wave's merge.

**Q3 — If Ring 1 under `--jev off` does not come back green, does C ship?**
The localiser fix landed on `main` at `0d61eef` but has **not been re-measured**, so this question is now about
a measurement rather than about writing a fix.
**Default: yes, with the stage-2 predicate additionally refusing when the decider is the off-decider, and the
limitation stated in `docs/STATUS.md` and in the arm's report.** This is a worse outcome than a green ring and
must be an explicit decision; see §7.7.

**Q4 — `ROUTER_DEADLINE_MS = 400`.**
It sits between Jev's p50 (237 ms) and p95 (547 ms), so roughly **one healthy answer in ten is discarded** —
invisible quality left on the table. The per-site deadlines in §2.2 (250/300/400/500/600 ms) are first guesses.
**Default: ship these numbers, record every row's `appliedAt`, and retune from the Ring-2 distribution rather than
from argument.**

**Q5 — `FASTPATH_MAX_T_RUN_MS = 800`.**
It is a **gap between two measured clusters** (QuixBugs 230–520 ms wins; sympy 1 574 ms loses), not a tuned
number. **Default: 800, and treat any retune as a §8.4 narrowing only.**

**Q6 — `FASTPATH_WALL_MAX_MS = 45 000` and the 0.35 step share.**
This is the dominant lever on prediction (b). **Default: 45 s / 0.35, with the `8 × tRunMs` floor. If (b) fails
while (a) holds, halve `FASTPATH_WALL_MAX_MS` to 22 500 and re-run the fresh 18 only.**

**Q7 — Does the byte-stable prefix (§3.3) justify re-capturing the `view: 'legacy'` golden?**
**Default: NO.** If the reorder changes legacy bytes, apply it only under the new arm's assembly path and leave
the legacy golden untouched. A cache hit is not worth a golden re-capture without the owner saying so.

**Q8 — Is the third arm (plain `jev-on` on the fresh 18) funded?**
It is one cheap run and it is the only thing that turns I2 from an assertion into a measured pair and gives
"making `jev-on` primary" a baseline at all. **Default: yes, run it; it is the cheapest arm in the plan.** If
budget forces a cut, cut the **in-sample 28** for `jev-on-next-nofast` before cutting this.

**Q9 — Who fixes `runFactsRef` (`src/synth/index.ts:83`)?**
~~It is a latent correctness defect today (a process-global read after awaits, with `src/bench/runner.ts` running
concurrent tasks in one process) and the reason every fast-path arm is pinned to `--concurrency 1`.~~
**ANSWERED AND CLOSED: it was fixed on `main` at `c7ae106`, outside this wave** (ratified in `docs/DECISIONS.md`
2026-09-22, "The LLM-loop wave lands with both switches off", Q9). `grep -rn runFactsRef src/` is empty; the facts
are a per-`runId` registry (`src/synth/introspect/facts.ts`, `RUN_FACTS_MAX = 8`, LRU). The `--concurrency 1`
assertion in slot D stands, but it is now a measurement-noise choice, not a correctness pin.

### 9.1 Deferred, with reasons

**Filed 2026-09-22 at `d297b29` by the finishing pass (F21) — two BEHAVIOUR deferrals it deliberately did not change,
each with an owner, so neither is mistaken for an oversight:**

- **The fast path's blanket `warm_plane` refusal** (`src/loop/stages/fastpath.ts:183`,
  `if (i.warmEnabled) return 'warm_plane';`, T1's free stage, ahead of everything that could spend). It was written
  for I8 while the warm plane was unmeasured. Since `JEVCODE_WARM` became opt-in the cost changed shape: under
  `JEVCODE_WARM=on` the refusal now costs **route R9 entirely** — every step of every `jev-on` run declines with
  `reason: 'warm_plane'`, so the two switches cannot be measured together at all. The narrower rule (refuse only when
  the plane would screen *this* cluster's lanes, or require a cold confirmation as the sieve already does) is a
  behaviour change with its own A/B and is **not** in a documentation pass. **Owner: the wave that flips the warm
  default** (`docs/DECISIONS.md` 2026-09-22 warm A/B: the default stays OFF until pass parity holds).
- **S2 on `jev-on` (the §3.2 hedge is unreachable from a run).** `hedgeEnabled(pinned, env)` takes the caller's pin
  first and **no site under `src/` sets `LlmSourceDeps.hedge`**, so `JEVCODE_HEDGE=on` is the only thing that can arm
  the hedge; a plain `jev-on` run never hedges however fast or slow its provider is. Arming it from the engine is a
  behaviour change on the default path. **Owner: finishing-pass F05.**

Persistent Jev cache + `--jev-cache off` (the exact-digest cache in `src/jev/cache.ts` already landed).
A `searchOneRound` API at the `searchSubGoal` altitude (§1.5 — `rebaseline` is private for good reasons).
Repository-class fast path (`src/synth/oracle/verify.ts`'s `runRepositoryQueue`).
Routers R3, R4, R5, R7, R8 (§2.2).
The warm plane (I8).
`screened` / `screenMismatches` in `ProposalEvidence` / `GoalSearchTrace`.
A hard per-round Jev cap as a `ControllerOptions` member (reported as `fastPath.jevRequests` instead).
M15 replay.
The `scopeUsable` hole in the **judge** (§6 row 14) — **owner: the next loop wave (S5 step avoidance), carried here
with its reason.** The loop's own `run` action has no scope guard: a generator-proposed narrow test command that
collects nothing reads green to the judge. The fast path's trigger is guarded (T3); the judge is not. The fix is a
guard at the judge, *not* writing `StepRecord.scopeUsable` unconditionally — that member is written only on an armed
step precisely because invariant I2 (`fastPath: 'off'` byte-identical to today's `jev-on`) forbids a new row on a step
that writes none today, and the data this row would add is not what the judge reads anyway.
The default-mode flip.

**Added by the finishing pass**, each with an owner, because a deferral without one is a silent drop:

- **F17 — S2 on the `jev-on` path.** `armMechanisms` pinned `s2: true` for `jev-on-next` /
  `jev-on-next-nofast` while no S2 mechanism is reachable in `jev-on`: nothing sets `PromptInput.prefixOrder`,
  `onFirstByte` is forwarded only on the synthesizer sample path, and hedging plus the §3.4 reasoning cap live in
  `src/synth/llm/source.ts`, which `jev-on` never enters. The finishing pass made the RECORD match the run (F05:
  `s2: false` off the `llm-jev` path, no `PinnedGeneration.s2` there, and an `S2` row reading `not_evaluable`);
  wiring the mechanisms onto `jev-on` is a mechanism change and is **slot A's F25**, which exposes a runtime
  `mechanisms.s2: 'on' | 'partial' | 'off'` for summary.json to record instead of a constant.
- **F26 — `cacheInput` counts only the rounds the provider reported cache for.** `cacheCountsOf`
  (`src/synth/llm/source.ts`) returns `{}` when a round's samples reported neither a cache read nor a cache write,
  so a round that priced 1,000 uncached input tokens contributes no denominator; `subgoal.ts`'s trace fold and
  `fastlaneCounts` (`src/synth/search/index.ts`) repeat the same `cacheRead > 0 || cacheWrite > 0` guard. A step
  that served 1,000 tokens on a miss beside one that served 90/100 therefore prints 90 %, not 8.2 %, and §3.3 cannot
  see a prefix break on a provider that does not report cache writes. The fix is three guarded spreads — emit
  `cacheInput` (and the rate) whenever `input > 0`, keeping `cacheRead`/`cacheWrite` absent when the provider
  reported none — but it CHANGES what the §3.4 instrument reports on every provider and contradicts a pinned
  decision (`test/unit/synth/llm/cache-and-reasoning-cap.test.ts`: "reports NOTHING rather than a zero when the
  provider caches nothing"), so it is a mechanism change and not a finishing fix, exactly as F17 is. Owner = §3.4
  (slot A). Until then §3.4 above and `src/bench/report.ts`'s S2 row say what the denominator covers.
- **`llm-sieve` still runs L2.** F06 constructs the arm (it used to throw, turning `--conditions llm-sieve` into a
  run directory of `engine_create_failed` and criterion 5a into a permanent `not_evaluable`), and the stub decider
  supplies §10.1's "every Jev question replaced by its code default". §10.1's row also says "no L2 (code oracle
  only)", and the L2 reproduction writer is an llm-jev mechanism the stub does not switch off — it only stubs L2's
  Jev judgement. Closing it is an `l2: false` `ControllerOptions` switch read in `initRepository`: owner = whoever
  funds the attribution arm's re-run, and the arm's cost line moves with it.
