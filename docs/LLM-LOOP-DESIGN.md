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
| `routers` | `'on' \| 'off'` | **`'off'`** in every mode | `'on'` | `JEVCODE_ROUTERS=on\|off` |

`routers` defaults **off on main** deliberately. The router wave carries three polarity changes — the risk
verdict, the replan stop, and completion — and none of them may reach a user run before the head-to-head of §8
decides. `fastPath` defaults `auto` in `jev-on` because it is purely additive: it can only propose, and it
degrades to "the LLM proposes as usual".

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
unit test *and* as a bench-wide blocking row. It is unasserted anywhere today and currently false for every ask
(`askRecorded` at `engine.ts:2847` is awaited inline), so making it true is a real change, and it is easy to
break silently later with nothing but latency as the symptom.

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
- **`runFactsRef` is process-global.** `src/synth/index.ts:83`:
  `const runFactsRef: { current: RunFacts | null } = { current: null };` — written at `:120` and `:139`, read at
  `:90` and `:156` *after awaits*. `src/bench/runner.ts` runs `--concurrency` tasks in **one** process, so two
  interleaved synthesizers can cross facts. Latent today; a hard blocker for the arm at concurrency > 1.
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
  readonly waitMs: 0;            // I3, in the type
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
4. A deadline, a `JevError`, a 503/529 or an abort are **one branch**: `dropped: true`, code order stands,
   nothing thrown. This single failure branch is what makes "a Jev outage is slower, never wrong" a structural
   property rather than a per-site promise.
5. The thunk is **injected**: `ask` is the stage's existing `ctx.ask`, which already routes through
   `askRecorded`. No router touches `engine.ts` except through the one `askRecorded` seam slot B owns.

The `ask` is still made, still metered, still written to `jev.jsonl`. `jevMs` may grow. `routerWaitMs` reads 0.

Two flavours. **Order routes** re-order a pending tail. **Branch routes** pick between branches whose code
default is already running — R9 is the only one in this wave.

### 2.2 The table

`routers: 'off'` (the default on `main`) leaves every row exactly as it is today.

| id | ask today | becomes | code fallback (and its named test) | deadline | consumer | cost of a dropped or wrong answer |
|---|---|---|---|---|---|---|
| **RL1** | Q7 intent, `stages/intent.ts:195` | order route | `INTENT_FALLBACK = 'investigate'`, or `codeIntent(lastProposal.kind)` when a previous step exists — `test/unit/loop/router.test.ts` › *intent falls back to investigate when the decider throws* | 250 ms | the prompt's intent section only | one sentence of one prompt |
| **RL2** | Q2–Q6 context, `stages/context.ts:94` | order route over the code pre-filter | today's pre-filter order; traceback frames and changed files are always members — › *context keeps the traceback frame when the decider throws* | 400 ms | `contextFiles`, the prompt's file section | a worse file order in one prompt |
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
records `dropped: true` otherwise. Unit test: *"a router answer landing after step commit is recorded dropped and
mutates nothing"*, driven by a decider that resolves on a timer past the commit.

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
`cacheRead` / `cacheWrite` / `cacheHitRate` on `StepVerifySummary`.

### 3.5 `--quick`

`src/bench/cli.ts` gains `--quick` (slot A owns `cli.ts`; slot D owns every other `src/bench` file). Global caps
per `HARNESS-NEXT-DESIGN.md` §3 M16.

**`src/core/limits.ts` is additive only**, and constants that belong to one owner live beside that owner —
`LLM_HEDGES_PER_ROUND` in limits (shared), `ROUTER_DEADLINE_MS` in `src/jev/router.ts`, the `FASTPATH_*` constants
in `src/loop/stages/fastpath.ts`. This is what keeps slots A and C from colliding in limits.ts.

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
contextFiles)`); `generate` and `reportVerify` are optional and omitted.

### 4.3 The trigger predicate — two stages, structural, no task names

The predicate prices its own false positive, which is why it is split. Stage 1 is free; stage 2 costs one baseline
run plus the localiser's routed asks, and `T10` makes that cost payable **at most once per fingerprint per run**.

#### Stage 1 — engine-side: pure code, zero Jev, zero LLM, zero test runs

All must hold.

| # | condition | source |
|---|---|---|
| T1 | `mode === 'jev-on'` and `fastPath === 'auto'` | option |
| T2 | `synthesizerHandles(wsInfo, files)` true (cached once per run) | `src/synth/index.ts:305` |
| T3 | the last executed action was a test `run` (`isTestCommand`, `stages/execute.ts:33`) whose parse is **`scopeUsable`** with `failed + errors >= 1` | `src/workspace/tests.ts:540` |
| T4 | no workspace write since that run (`lastChangeStep` / `changedFiles`) | engine state |
| T5 | `lastTestRun.durationMs <= FASTPATH_MAX_T_RUN_MS = 800` | **new contract-1.9 member** (§5) |
| T6 | the code-derived suspect set — `framesOfTraceback` ∩ workspace files, plus `mentionedInTask` — is **exactly one** non-test source file | `search/index.ts:1621`, `:360` |
| T7 | failing test count ≤ 8 (one cluster, not a broken build) | parsed counts |
| T8 | `isRepositoryWorkspace(testCommand, paths)` false and `detectLayout(paths) !== 'other'` | `search/index.ts` |
| T9 | spend remaining > 0, and **wall left ≥ 2 × the fast-path budget** | budgets |
| T10 | this `(file, failing-test-id-set)` fingerprint has not already been declined or exhausted this run | per-run set |
| T11 | `goal.attempts < FASTPATH_ATTEMPTS_MAX = 2` for this cluster, and **the fast path is not disarmed** (§4.5) | per-run state |
| T12 | the loop detector is not tripped, no pause point is pending, and no coordination lease conflict is known on the implicated file | engine state |

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
| test runs | `min(FASTPATH_TEST_RUNS_MAX = 400, runsLeft(oracle, stepBudget))` — against QuixBugs class's own 1 500; this is one round, not a step |
| Jev requests | `FASTPATH_JEV_MAX = 6` — up to 5 for `locate` (Q2–Q6) and one for RS5 arbitration. **Zero is legal**: with the budget spent or Jev down, `locate` falls to code order and `decide`'s `canAsk` guard drops arbitration |
| generator | **0 by construction** (`mode: 'jev-only'`) |
| full-suite runs | today's `MAX_FULL_SUITE_RUNS_PER_STEP = 5`, counted on `mem.passersThisStep` |
| cold-confirm reserve | `2 × tRunMs.fullSuite`, held **outside** the wall share |

**The cold-confirm reserve is held outside the wall share** because *a passer without its confirm run is not a
result*. Spending the last of the wall on one more candidate and then having no wall to confirm it produces
exactly the failure mode the fast path must never have.

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
existing and passing. If the warm plane is ever turned on, `screened: true` without `confirmedCold` can never
reach `decide()`, and a screen mismatch re-queues the whole batch cold — which will usually hit the wall cap
first, a clean budget exit.

Anything else — `{kind:'budget'|'parked'}`, a `run`/`done` proposal, a throw, a timeout, a dropped or unreleasably
held passer — means **the LLM proposes as usual**, and the wall already spent is the only loss.

**One-strike disarm** (graft, judge 1 §6). Any of: a round timeout, a thrown error, an unstable-oracle drop, or a
failed cold confirm **disarms the fast path for the rest of the run** (T11). Together with the two-attempt cap and
T9 these are the cheapest bounds on the wall-spent-and-not-won-back regression, which is the fast path's dominant
cost risk.

**`refused` is not `no_passer`.** The guard can refuse passers silently: `structuralRejection` and
`mutationRefused` drop them before any rule, and a lone passer under `LONE_PASSER_HOLD_MAX_NOUL = 0.3` is held
**unreleasably**. Reading only `kind` would report "no passer" when the truth is "passers found and refused". The
facade surfaces `GuardFields.dropped / structuralDrops / held / signals` into the record and such a step records
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
| passers found and refused | guard fields | LLM proposes, **disarm** | `outcome: 'refused'`, `held`, `structuralDrops`, `dropped` |
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
  budgetMs: number;
  passer: boolean;
  confirmedCold: boolean;
  structuralDrops: number;
  held: number;
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
  rows: readonly { id: string; source: 'jev' | 'code'; appliedAt: number | null; dropped: boolean }[];
}
```

`FastPathReason` is a **string union**, not a free string, so the decline histogram of §8 is exhaustive:
`'off' | 'not_jev_on' | 'no_synthesizer' | 'no_parsed_run' | 'scope_unusable' | 'all_passing' | 'workspace_changed' |
't_run_too_slow' | 'multi_file' | 'too_many_failures' | 'repository_class' | 'no_wall' | 'fingerprint_seen' |
'attempts_exhausted' | 'disarmed' | 'loop_tripped' | 'pause_pending' | 'lease_conflict' | 'oracle_class' |
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
`cacheRead?: number`, `cacheWrite?: number`, `cacheHitRate?: number`.

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
    stage1Fired: number; stage2Declined: number;
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
| 7 | **Pause point lands inside a round** | the round runs under `AbortSignal.any([ctx.signal, timeout])`, so a `human_pause` aborts it exactly like any in-flight propose: `searchSubGoal` returns on `ctx.signal.aborted`, lanes are torn down by the engine's layer-4 `sandbox.killAll()`. The partial round is **discarded**, never cached as a replayable proposal | no new pause point and no new `PausePoint.phase`, because the fast path is not a stage | `outcome: 'error'`, `wallMs`, `interruptedAt: { stage: 'propose' }` |
| 8 | **Resume after a process restart** | `lastTestRunOutput` is in-memory only, so the predicate **cannot arm** until the next verification run — which is correct. `LastTestRun.durationMs` survives, so T5 is evaluable as soon as one does | the round is not resumed; the fingerprint is re-evaluated from scratch and `mem.tried` is fresh | `reason: 'no_parsed_run'` — recorded, never silent |
| 9 | **Coordination lease conflict** | the round itself edits nothing in the workspace (candidates apply under `<runDir>/lanes/laneN`), so no lease is needed to **search**. The returned proposal goes through the unchanged coordinate micro-stage and `checkBudgets` at `engine.ts:3986–3998` | T12 additionally declines to arm when a conflict on the implicated file is already known, so the round's wall is not spent on a patch that cannot land | `reason: 'lease_conflict'` |
| 10 | **Lanes are invisible to a peer** | a fast-path round's lanes write under `<runDir>/lanes/`, outside the workspace and outside the lease | correct (they are shadow copies), but it means a round is invisible to a peer's conflict view until the patch is proposed | — (named, not recorded) |
| 11 | **The ledger claims a commit the engine never executed** | the synthesizer records a commit when it **proposes**. If risk blocks, a human declines, or the apply fails, `patchNotExecutedLastStep(window)` + `rollbackUnexecutedPatch` undo it — but only on the **next** fast-path entry. If the fast path is never re-entered the stale record survives to run end and is dropped by `dropMemory(runId)` | bounded and harmless (nothing outside the synth memory reads that ledger in `jev-on`), **provided** the facade calls `observeWindow` on **every** step of an armed run (§4.6) | — |
| 12 | **Second fast path on the same cluster** | `mem.tried` is monotone, so the second round enumerates nothing. T10 and T11 make it unreachable rather than merely fast | three mechanisms take hashes back out (`forgetUnchangedTried`, `requeueScreened`, a re-baseline) and the facade assumes none of them ran | `reason: 'fingerprint_seen'` / `'attempts_exhausted'` |
| 13 | **`emptyStepBudget` trap** | cannot occur: the fast path calls the public `synthesize()`, so `rebaseline` installs `mem.stepBudget` (`search/index.ts:1262`) | a caller entering at `searchSubGoal` would get `exhausted: () => true` (`memory.ts:164`) and an instant `{kind:'budget'}` indistinguishable from an honest decline | the facade's **first unit test** asserts `candidatesTested > 0` on a known-solvable cluster |
| 14 | **Narrow test command reads green** | T3 applies `scopeUsable` to the engine's own last test run before the fast path trusts it | closes the hole **for the trigger**; the same hole in the **judge** remains and is out of scope — which is why `scopeUsable` is recorded on every step even with the fast path off | `scopeUsable: false`, `reason: 'scope_unusable'` |
| 15 | **Two concurrent fast paths in one process** | `runFactsRef` (`src/synth/index.ts:83`) is process-global and read after awaits at `:90`/`:156`; `src/bench/runner.ts` runs `--concurrency` tasks in one process | **the `jev-on-next` arm runs at `--concurrency 1`**, asserted by slot D, until the ref is made per-run | a named bench constraint, not a silent hazard |
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
2. `npx vitest run --maxWorkers=3` — the full unit suite.
3. **The facade's first unit test asserts `candidatesTested > 0`** on a known-solvable cluster (§6 row 13).
4. **I2 golden**: `fastPath: 'off'` on the existing `jev-on` fixtures is byte-identical.
5. `fastPath.wallMs <= budgetMs` on every fired step in the test fixtures.
6. **Ring 1 re-measured green under `--jev off`** — a **hard merge gate** (see §7.7). The code fix landed at
   `0d61eef`; the measurement has not been taken.
7. `node scripts/check-pack.mjs` at the 3.5 MB unpacked gate.

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

**Gates:** `npm run check`; `npx vitest run --maxWorkers=3`; a dry-run of `quick-table.mts` and `headtohead.mts`
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
9. `npx vitest run --maxWorkers=3`, `npm run check`.

### 7.6 Slot A — the S2 generator path

**Files (exclusive):** `src/provider/sse.ts`, `src/provider/types.ts`, `src/provider/http.ts`,
`src/provider/{anthropic,openai-compat,openrouter}.ts`, `src/provider/prompts.ts`, `src/provider/generate.ts`,
`src/synth/llm/source.ts`, `src/synth/llm/prompt.ts`, `src/synth/search/llm.ts`, `src/bench/cli.ts` (`--quick`
only), `src/core/limits.ts` (additive), `src/core/types.ts` (the `StepVerifySummary` members),
`test/unit/provider/**`, `test/unit/synth/llm/**`.

**Gates:** `npm run check`; `npx vitest run --maxWorkers=3`; the `view: 'legacy'` prompt golden — **unchanged, or
the change is stated and the golden re-captured with a reason** (§3.3); a budget-refusal test proving a hedge is
declined when the budget cannot hold one more estimated-full-cost sample; cancelled-leg cost still reaching
`generator.jsonl`.

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
| `jev-on-next-nofast` | `jev-on` | **off** | on (after B) | tuned + S2 | S2 + routers, without the fast path |
| `jev-on-next` | `jev-on` | auto | on (after B) | tuned + S2 | the whole wave |
| `llm-jev` | — | — | — | — | **recorded** rows, `experiments/results/llm-jev-iter1.md` |
| `jev-off-tuned` | — | — | — | — | **recorded** rows, same file |

**The `jev-on-next-nofast` control is the single most valuable device in the plan.** Without it a
`jev-on-next` win confounds tuned generation + S2 + routers + the fast path. The two arms run as a **paired
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
- `--maxWorkers=3` for the unit suite; the bench's own concurrency is separate.
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
  `env -u ANTHROPIC_API_KEY node --env-file=/Users/prateekjannu/Documents/vscode/JevCode/.env …`.
- If `/tmp/jevcode-perf-window-open` exists, nothing starts.

**Cost.** Two (later three) arms × 46 tasks at forced concurrency 1 is the most expensive honest measurement on
offer. It is the price of attribution; a cheaper single-arm run buys a number nobody can interpret.

### 8.3 Rows

Via `experiments/llm-jev/headtohead.mts`, which already gives paired tables, the one-sided exact sign test on
discordant pairs, Wilson intervals, the median-wall Wilcoxon, `$/task` and `$/solved`, and criteria 1–5.

**Five new rows, all blocking:**

| row | source | pass condition |
|---|---|---|
| R-a | `routers.waitMs` p95 over every step | **= 0** |
| R-b | `fastPath.wallMs <= budgetMs` over every fired step | **100 %** |
| R-c | stage-1-fired / stage-2-declined ratio, per suite | **≤ 0.3**; above that the **predicate** is wrong, not the budget |
| R-d | the per-reason `fastPath.reason` decline histogram on every ineligible step | exhaustive over `FastPathReason`, no `'error'` bucket > 5 % |
| R-e | `riskSource: 'code'` count and `jevUnavailable` count | reported; any step where a *harmful* command was allowed under a dropped ask **reverts the §2.4 ratification** |

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
4. (f) holds, i.e. the paired control attributes the win to the fast path — **or** the fast path is retired under
   §8.4 and the wave ships as S2 + routers alone, with `fastPath` defaulted `'off'` in every mode.
5. R-e shows no allowed harmful command; otherwise §2.4 is reverted and slot B's risk change is backed out
   independently of the rest.

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
It is a latent correctness defect today (a process-global read after awaits, with `src/bench/runner.ts` running
concurrent tasks in one process) and the reason every fast-path arm is pinned to `--concurrency 1`, which is most
of the measurement's cost. **Default: out of scope for this wave; filed in `docs/STATUS.md` as the next harness
defect, with the `--concurrency 1` assertion in slot D as the interim guard.**

### 9.1 Deferred, with reasons

Persistent Jev cache + `--jev-cache off` (the exact-digest cache in `src/jev/cache.ts` already landed).
A `searchOneRound` API at the `searchSubGoal` altitude (§1.5 — `rebaseline` is private for good reasons).
Repository-class fast path (`src/synth/oracle/verify.ts`'s `runRepositoryQueue`).
Routers R3, R4, R5, R7, R8 (§2.2).
The warm plane (I8).
`screened` / `screenMismatches` in `ProposalEvidence` / `GoalSearchTrace`.
A hard per-round Jev cap as a `ControllerOptions` member (reported as `fastPath.jevRequests` instead).
M15 replay.
The `scopeUsable` hole in the **judge** (§6 row 14) — recorded here, fixed elsewhere.
The default-mode flip.
