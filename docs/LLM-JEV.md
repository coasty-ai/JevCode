# LLM-JEV — measurement log

The running log of the `llm-jev` mode (docs/LLM-JEV-DESIGN.md: the full engine with the Synthesizer, the generating LLM as a
candidate source inside it, Jev localising and arbitrating, shadow lanes verifying; bench arm `--conditions llm-jev`). One dated
entry per measurement, with the numbers, the run ids and the report they come from; the design doc holds the plan and the
criterion, `experiments/results/` holds the reports. Live results only — nothing here is projected.

## §5a Harness environment switches (reference, not a measurement)

Every environment variable that **changes what a run does**, in one table, because four of them
(`JEVCODE_HEDGE`, `JEVCODE_CASE_TIMEOUT_MS`, `JEVCODE_MAX_CASE_TIMEOUTS`, `JEVCODE_BENCH_CONTEXT`) appeared in no
document at all before 2026-09-22 and four more existed only inside design prose with no default and no effect —
so a measurement could inherit one from the shell and nobody could tell from the record. Presentation and settings
variables (`JEVCODE_MODE`, `JEVCODE_THEME`, `JEVCODE_ASCII`, the `JEVCODE_MOCK_*` and `JEVCODE_ASSERT_*` test hooks,
…) are NOT here; they belong to the settings table in `src/config/defaults.ts` and to the TUI docs.

**Two rules hold for all of them.** (1) An unset or unrecognised value is always the pre-existing behaviour — a
typo disarms a switch, it never arms one. (2) Where an in-process option exists for the same mechanism, **the
explicit option wins and the environment only fills an ABSENT option** (`routersEnabled`, `resolveFastPathOption`,
`hedgeEnabled`); an arm's recorded row is therefore always the truth about what it ran.

<!-- env-switches:begin -->
| Switch | Accepted values | Default (unset) | Effect | Read in |
| --- | --- | --- | --- | --- |
| `JEVCODE_JEV` | `off` / `0` / `escape` / `down` / `503` / `unreachable` (`off`,`0` → escape; `down`,`503` → unreachable) | unset — the real decider | Replaces the Decider with a deterministic double: every Choice takes the escape option, every Noul is inert at 0.5, every Score sits at its TOP level (so the destructive gate can only tighten). Bench/perf only — there is no `--jev` CLI flag, and the single caller is the bench runner | `src/jev/off.ts` (`jevOffModeFrom`, `withJevOff`), applied at `src/bench/runner.ts` |
| `JEVCODE_ROUTERS` | `on` (anything else is off) | off in every mode | Arms the contract 1.9 §2 speculative router table (`routeSpeculative`). An explicit `EngineOptions.routers` wins; the env fills only an absent option. The `jev-on` gate stays ahead of both | `src/jev/router.ts` (`routersEnabled`) |
| `JEVCODE_FASTPATH` | `auto` / `off` | `auto` when the mode is `jev-on`, `off` otherwise | Arms route R9, the Ledger+Sieve fast path. An explicit `EngineOptions.fastPath` wins; the env fills only an absent option | `src/loop/engine.ts` (`resolveFastPathOption`) |
| `JEVCODE_WARM` | `on` / `1` / `true` (anything else is off) | OFF for every runner | Asks for the warm verification plane (a persistent forked interpreter that SCREENS candidates; a passer is always re-verified by a cold spawn). A runner with no warm shape records `warm.mode: 'unsupported-runner'` instead of silently running cold. Also refuses the fast path outright (`reason: 'warm_plane'`) | `src/synth/warm/plane.ts` (`warmRequested`, `warmModeFor`) |
| `JEVCODE_HEDGE` | `on` (anything else is off) | off | Arms the contract 1.9 §3.2 hedge: one twin per round fired after `hedgeAfterMs(p50 TTFB)`. A caller's `LlmSourceDeps.hedge` pin wins — but **no site under `src/` sets one**, so this variable is today the ONLY way the hedge can arm | `src/synth/llm/source.ts` (`hedgeEnabled`, `HEDGE_ENV_FLAG`) |
| `JEVCODE_DEADLINE_GROWTH` | `served` / `always` | `always` (byte-identical to the behaviour before the switch existed) | `served`: a zero-token timeout backs a goal's deadline off only once a sample of that goal has actually been SERVED, so a provider that never answers stays at the class base. Recorded per run on `StepsSummary.deadlineGrowth` | `src/synth/llm/source.ts` (`deadlineGrowthMode`, `DEADLINE_GROWTH_ENV_FLAG`) |
| `JEVCODE_CASE_TIMEOUT_MS` | a positive integer, milliseconds | 2000 ms (`CASE_TIMEOUT_S = 2`, run_tests.py's own `--timeout`) | The per-case limit inside the GENERATED pytest module. The sieve sets it per shadow lane from the oracle's measured per-test timeout; exported by hand it changes every lane of every QuixBugs run | `src/synth/verify/quixbugs.ts` (`CASE_TIMEOUT_ENV`), consumed by the module built in `src/bench/quixbugs/pytest.ts`, set per lane in `src/synth/sieve/runner.ts` |
| `JEVCODE_MAX_CASE_TIMEOUTS` | a positive integer | unset — no limit (the sieve sets 1 on its own lanes, `LANE_MAX_CASE_TIMEOUTS`) | After this many case timeouts in one run the remaining cases are reported "not run" rather than called. This is what keeps a hanging candidate from costing the whole per-case budget on every case | `src/synth/verify/quixbugs.ts` (`MAX_CASE_TIMEOUTS_ENV`), consumed by `src/bench/quixbugs/pytest.ts`, set per lane in `src/synth/sieve/runner.ts` |
| `JEVCODE_BENCH_CONTEXT` | `relaxed` (anything else is legacy) | `legacy` | Flips **every** bench arm's `contextPolicy.view` from legacy to relaxed, i.e. changes the prompt every arm sends. An arm that wants the relaxed view should set `contextPolicy` on its own condition object; this switch is the whole-run override and is easy to leave exported | `src/bench/conditions.ts` |
<!-- env-switches:end -->

`test/unit/hygiene/env-switches-documented.test.ts` discovers this set from `src/` (an exported `JEVCODE_*` constant
outside the TUI-owned trees that is used as an `env[…]` subscript, plus three switches read by literal subscript)
and fails if any of them has no row, if a row has an empty column, if a row names a switch nothing reads, or if a
row's "Read in" file does not actually read it.

## 2026-09-21 — first head-to-head against the GLM generator-only baseline (HEAD 626fc40)

Report: `experiments/results/llm-jev-headtohead.md` (tool output `llm-jev-headtohead.tool.md`, `.tool-rerun.md`); probes
`experiments/results/llm-jev-probes.md`; baseline `experiments/results/glm-jev-off-baseline.md`. Records under
`bench/results/llm-jev-{smoke,quixbugs,ladder,swebench,swebench-rerun}`. Frozen worktree `.claude/worktrees/llmjev-clean`,
generator `openrouter z-ai/glm-5.3-flash`, Jev `typesafe/jev-1.13-20260917` (wire id `jev-1.13.0`), same 28 tasks, limits and
concurrency as the baseline. Spend $0.406 of a $6 cap.

Pooled (28 paired tasks):

| arm | pass | correct-by-verdict (22 cheap-test) | wall median / mean | $ total (gen + Jev) | $ / task | $ / solved | steps mean | Jev requests |
|---|---|---|---|---|---|---|---|---|
| jev-off (baseline) | 19/28 | 16/22, 0 overfit (+ 3/6 SWE) | 391 s / 480 s | $0.5062 ($0.5062 + $0) | $0.0181 | $0.0266 | 10.8 | 0 |
| jev-off-tuned | not run — `src/cli/args.ts:284 CONDITIONS` rejects the arm (exit 2, $0) | | | | | | | |
| llm-sieve | not run — `src/synth/index.ts:322` throws ConfigError (not wired) | | | | | | | |
| llm-jev, as run | 22/28 | 17/22, **5 overfit** (+ 0/6 SWE) | 80 s / 126 s | $0.2704 ($0.0695 + $0.2010) | $0.0097 | $0.0123 | 3.6 | 741 |
| llm-jev, 3 Jev-outage SWE runs replaced by the re-run | 23/28 | 17/22, 5 overfit (+ 1/6 SWE) | 80 s / 114 s | $0.3024 ($0.0715 + $0.2309) | $0.0108 | $0.0131 | 3.6 | 838 |

Per suite (llm-jev vs jev-off): QuixBugs 10/10 vs 7/10 (b 3, c 0), correct 8 vs 7 (overfit detect_cycle, wrap), wall median
33 s vs 93 s (0.36×, Wilcoxon p = 0.003), $ per solved 0.20×; ladder 12/12 vs 9/12 (b 3, c 0), correct 9 vs 9 (overfit shipping,
textstats, stats), wall median 47 s vs 289 s (0.16×, p < 0.001), $ per solved 0.29×; SWE 0/6 as run (3 runs killed by Jev HTTP
503/529 at 23:31–23:34 Z) and 1/6 with the re-run vs 3/6 (b 0, c 2: sympy-11618, django-15315; both: sympy-17139 at 6m02s / 3
steps vs 25m / 13 steps), $ per solved 2.43×.

Criterion (§1.3, absolute bars pre-registered for n = 40/20/30, applied verbatim at n = 10/12/6): **failed** — QuixBugs 1 (b − c = 3
< 8; p = 0.125) and 2 (Δ +1 < +8), ladder 2 (Δ 0 < +2; overfits 3 > 1), SWE 1 (c = 2, b = 0) and 4 ($ per solved 2.43× > 0.75×);
**passed** — ladder 1, wall 3 on QuixBugs and ladder (and on SWE's one both-solved task with the re-run), cost 4 on QuixBugs and
ladder, refused steps 0, modelDrift 0, Jev share of wall 3.7 / 7.3 / 8.0 % (≤ 15 %); patchEmpty 5 vs 2 on SWE as run (2 vs 2 with
the re-run). Attribution (criterion 5) not evaluable: neither control arm ran.

What the transcripts say: GLM under `propose_fix` + `effort: low` returned 0 malformed samples in 228 (the baseline lost 27 % of
383 calls to `length` stops), but 77 samples hit the 20 s / 30 s deadline and 19 died of OpenRouter 429; 60 % of valid extra samples
duplicated sample 0. The seeds carried 15 of 22 cheap-test commits and all 6 SWE commits (4 rejected by the evaluator); the LLM
carried lis, wrap, shortest_path_length, grades, units and the second hunks of inventory, account, textstats. Every overfit is
the guard committing a test-fitting seed or a guarded LLM variant over the general candidate (wrap: Jev's Q17 chose the guarded
LLM patch 0.95 over the gold seed; textstats and django-15315 were committed at "max general 0.11–0.12"). On repositories the
SEEDS/RANK phase spends the run budget before LLM hunks are tested (sympy-17139 as run: 15 distinct LLM candidates, 0 tested),
the L2 reproduction can be narrower than the hidden test (sympy-15345: `Max` only, the test needs `Min` too) or unstable
(django-15315), and two runs ended `replan_stop` after three repeated `done partial` claims with most of the wall unused.
Jev is 74 % of llm-jev's cost (SWE: 405 requests / 23,396 questions as run). Peak RSS 4.49 GB on SWE (baseline ≈ 1 GB).

Recording gaps found: `generator.jsonl` and `steps.jsonl.usage.generator` hold only first-step LLM rounds (later rounds are
logged under `[step 1]` and unrecorded; `cost.generator` and `generatorCalls` in the record are complete); `synth.verify` in every
record is all zeros; `tasks.jsonl` carries `not_run` placeholders per started task; the CLI's condition list omits the two
attribution arms.

Verdict, one line: far faster (0.16–0.36× median wall) and cheaper (0.20–0.29× per solved) with more passes on the 22 cheap-test
tasks, but not more correct (5 overfits vs 0) and a loss on SWE-bench (1/6 vs 3/6) — the guard and the repository search order are
what to fix before the criterion can be re-measured on the full §10.3 set.

## 2026-09-21 — second head-to-head after the fix rounds (HEAD 066816f), with the `jev-off-tuned` attribution arm

Report: `experiments/results/llm-jev-headtohead-v2.md` (tool outputs `llm-jev-headtohead-v2.tool.md`, `.tuned-vs-baseline.tool.md`,
`.llmjev-vs-tuned.tool.md`); records `bench/results/llm-jev-v2-{smoke,quixbugs,ladder,swebench}` and
`bench/results/glm-jev-off-tuned-{quixbugs,ladder,swebench}`; frozen worktree `.claude/worktrees/llmjev-v2`, same 28 tasks,
generator, Jev id, limits and concurrency as the baseline and v1. Spend $0.389 of a $6 cap. llm-jev v2 passes **28/28** (baseline
19/28, tuned 22/28, v1 23/28; pooled discordant b = 9 / c = 0 vs the baseline, 6 / 0 vs tuned, 5 / 0 vs v1), correct-by-verdict
**20/22 with 2 overfits** on the cheap-test suites (v1 17/22 with 5; baseline 16/22 with 0; tuned 16/22 with 2) and **SWE-bench 6/6**
(baseline 3/6, tuned 4/6, v1 1/6) with every SWE commit an LLM hunk (v1: six seeds, four rejected); median wall 62 s pooled
(baseline 391 s, tuned 111 s, v1 80 s) — 0.39× / 0.14× / 0.09× the baseline per suite and 1.10× / 0.34× / 0.73× the tuned arm;
$0.144 total ($0.046 GLM + $0.099 Jev), $0.0051 per solved (baseline $0.0266, tuned $0.0110); RSS peak 2.9 GB on SWE (v1 4.5 GB).
Criterion (§1.3, absolute bars at n = 10/12/6): still **failed** on QuixBugs 1 (b − c = 3 < 8, p = 0.125) and 2 (Δ +2 < +8) and SWE 1
(b − c = 3 < 4) — all three unreachable by construction with this baseline — and **passed** on everything reachable: ladder 1–4
(correct 11 vs 9, overfits 1 ≤ 1), wall 3 and cost 4 on all three suites (SWE cost 0.12× where v1 was 2.43×), S1–S3, Jev share
3–9 %; criterion 5b: the tuned arm does not match llm-jev on pass or correctness and llm-jev is strictly better on ≥ 2 of
{correct, $ per solved, wall} on every suite (5a not evaluable, `llm-sieve` still not wired). What the transcripts show: the
unreleasable hold refused the lone narrow passers that v1 committed (wrap donor at general 0.06, sympy-15345 at 0.14 — the next
round's `Max`+`Min` candidates were arbitrated instead), LLM-first ordering on repositories ended class B (2–10 runs per commit,
`streamed batch ended on its first passer` ×5, 6 samples cancelled at commit), shipping/textstats are gold-identical LLM hunks,
GLM 0 malformed in 100 samples. Remaining: two overfits from the `fewest_special_cases` code rule deciding among guard-only clusters
with no LLM member present (`detect_cycle`; `stats` now `values.remove(mid)`, a strong overfit where v1's was exception-class only),
31 % of samples cut at the deadline (61 % on QuixBugs, all rows served by `Inceptron` — QuixBugs median 36 s vs v1's 33 s), and
sympy-11618 ending `replan_stop` after its fix against a judge that saw 43 pre-existing suite errors (evaluator pass). README's llm-jev
paragraph has no results rows and was left alone.

## 2026-09-21 — v2 leftovers round: the three classes the head-to-head left open (HEAD 8124e07, branch `v2-leftovers`)

Code, not a suite: the three items that §9 of `experiments/results/llm-jev-headtohead-v2.md` left open — class A′ (generality-by-code picking a
test-fitting seed when only seeds are in the clusters), class C′ (31 of 100 samples cut at the fixed 20 s / 30 s deadline) and class E′
(`sympy-11618` re-claiming `done partial` against 43 pre-existing collection errors) — are now built: the probe's majority decides an
all-seed split of equal support before any special-case count (`seedOnlySplit` / `probeMajorityCluster`, `CodeRule 'probe_majority'`,
`src/synth/search/guard.ts`); the per-sample deadline adapts as `clamp(2 × the running p90 of SERVED samples, the class default,
45 s cheap / 90 s repository)` and a provider whose served p90 is past the class default makes the run cap every further sample's
`reasoning: {maxTokens}` at 512, one-way (`LLM_DEADLINE_ADAPT`, `sampleDeadlineMs`, `providerSlow`, `src/synth/llm/source.ts`); and the
base commit's known failures travel on the claiming run's evidence, so the completion fact and the code judge compare against them
instead of against zero (`KnownFailuresEvidence`, `unexpectedFailures`, `src/loop/stages/complete.ts`, `judge.ts`; the count is measured
at the base commit and may only be lowered by a later re-baseline, `search/index.ts`). Design text: DESIGN §22.3 / §22.5 / §22.6,
LLM-JEV-DESIGN §4.8 rev 3, §6.2 rev 3, §6.6 rev 3.

Two live single-task runs, one per overfit v2 left behind, same generator (`z-ai/glm-5.3-flash`), Jev `jev-1.13.0`, limits and
evaluator as v2; $0.0017 spent across the two, each under its own $0.05 cap. Both pass and both end `complete` at step 2.

| task | run id | steps / wall / cost | guard decision | verdict vs v2 |
|---|---|---|---|---|
| ladder `stats` | `20260922-034352-4n5ogwb3` | 2 · 11 s · $0.0010 | `the clusters split with no LLM member and equal support; committing template/guard_empty_raise at src/stats.py:22:insert — cluster_1 agrees with the passers' majority on the perturbed inputs (cluster_1 4/4, cluster_2 0/4; … +1c/+1l; … +0c/+0l) by code (no arbitration)` | **weak (exception-class-only) overfit, 2/111** differential inputs — v2's count-based pick was a **strong** overfit at 9/111 (`values.remove(mid)`: `median` mutated its argument, `AttributeError` on tuples) |
| QuixBugs `detect_cycle` | `20260922-034312-5vndocme` | 2 · 38 s · $0.0007 | `5 passers (0 held) in 2 behaviour clusters (probe 16 inputs, 5/5 signatures; cluster_1 3 members/support 2, cluster_2 2 members/support 1); cluster_1 holds the majority of the independent support; committing its representative llm/sample_0_0` | passes 6/6 reference cases with an **LLM hunk that differs from the reference on `detect_cycle(None)` alone** (1/500 random lists) — v2's `if not hare.successor.successor: break` differed on 126/500 |

Records `bench/results/llm-jev-v2-leftovers-{stats,detect-cycle}` (`verdicts.md` from `experiments/inspect/{ladder,quixbugs}-verdicts.mts`,
code only, no Jev). What the two runs show, exactly: `stats` is the class-A′ path itself — the probe's majority committed the +1c/+1l guard
(`if not ordered: raise ValueError("median of empty sequence")`) that `fewestSpecialCases` had rejected in favour of the +0c mutation, so the
committed patch now differs from gold only in the exception class two `None` inputs raise. `detect_cycle` never reached that rule: its LLM sample
was served in 6.7 s where v2's timed out at 20 s, so the set had an LLM member, `majorityCluster` fired on support 2 vs 1 and the LLM hunk
was committed — the shape class C′ said the fixed deadline had been costing, reached here without the deadline having to adapt at all.
Neither run exercised the adaptation (both samples inside the 20 s class default; the rounds record `deadline 20000 ms`) and neither is a
repository run, so class C′ under a slow provider and class E′ on
`sympy-11618` are **built but not yet re-measured live**; a full 28-task re-run is what would settle them.

What these two runs are **not**, stated so the record cannot be read as more than it is (and answering item C3 of
`experiments/results/llm-jev-headtohead-v2.verification.md`, which flagged these very directories while they were untracked): they are the
29th and 30th fits of two tasks that were graded during development, on a tree changed in response to their failure. They show that the
rule does what it was written to do on the two cases that motivated it — nothing about behaviour on a task nobody has inspected. The same
verification refutes "the only overfits are `detect_cycle` and `stats`" as a behavioural statement (ladder `units` diverges from gold on 10
of 20 string inputs, invisible to `LADDER_HARNESS`'s perturbations, so the cheap-test count is 19/22 with 3 divergences) and notes that SWE
"correctness" is defined as pass. Out-of-sample evidence for any of this needs the pre-registered §10.3 set — QuixBugs 40 twice, ladder 20
including the long tier, SWE 30 — which has never been run.

---

## 2026-09-22 — the same-build plain baseline, and the first out-of-sample measurement of the mode

Two things the v2 head-to-head did not have, measured live from the same frozen worktree `.claude/worktrees/llmjev-v2` @ `066816f`
(jevcode 0.3.0 in every `run.json`; generator `openrouter z-ai/glm-5.3-flash`, Jev `typesafe/jev-1.13-20260917`), $1.6752 total,
no source edited, nothing committed. Full report and tables: `experiments/results/llm-jev-headtohead-v2.oos.md`;
tool outputs `llm-jev-headtohead-v2.samebuild.tool.md` and `llm-jev-headtohead-v2.oos.tool.md`; records under
`bench/results/glm-jev-off-samebuild-*` and `bench/results/oos-{llm-jev,glm-jev-off-tuned}-*`, each with `verdicts.md`.

**1. The 19/28 baseline was partly the build.** Plain `jev-off` re-run on the identical 28 tasks from `066816f` scores
**21/28**, not 19/28 — six of 28 tasks flip against the `214bf55` measurement (`mergesort`, `account`, `calendar_utils`,
`table` gained; `grades`, `sympy-11618` lost), pooled median wall falls 390.8 s → 246.3 s and capped runs 10 → 8. Six flips
on a re-run of the same arm is also this baseline's run-to-run noise: about ±2 tasks. Against the same-build control
`llm-jev` v2 is **28/28 vs 21/28** (Wilson [88 %, 100 %] vs [57 %, 87 %]), discordance **b = 7 / c = 0** (exact sign
p = 0.0078), correct-by-verdict 26/28 vs 20/28 with the same **2 discordant correctness losses** (`detect_cycle`, `stats`;
the new baseline contributes one of its own, ladder `calendar_utils`), median wall 63.0 s vs 246.3 s pooled and
**39.5 s vs 175.3 s on the 21 both solved** (per-task ratio median 0.291, `llm-jev` slower on 1 of 21), $0.1441 vs $0.5875.
The lead-in of `llm-jev-headtohead-v2.md` should now read "vs 21/28 (plain, same build) / 22/28 (hygiene-tuned, same build)",
keeping 19/28 only as the historical `214bf55` figure. Censoring is still one-sided: baseline 8 of 28 at the wall cap and
19 of 28 solved-and-self-terminated, against 0 and 27 for `llm-jev`. 78 % of the candidate's dollars remain estimate
(generator, 30.5 % of its generator spend) or rate card (Jev, $0.098573, `costBasis: "table"`); the baseline's are 100 % provider-reported.

**2. Out of sample the mode does not beat tuned generator-only on pass, wall or dollars.** 22 tasks picked by fixed rules
that exclude every name §7's in-sample disclosure lists, the ten QuixBugs gold fixes quoted in the Q7 `edit_class` wording
(audit §3.2), and the v1/v2 fix-round motivating cases: QuixBugs
`breadth_first_search, get_factors, hanoi, is_valid_parenthesization, knapsack, lcs_length, levenshtein, next_palindrome, pascal, powerset`;
the whole ladder long tier; SWE `sympy-13798, sympy-16792, sympy-20428, sympy-22080` (the first four of the 30 that are
neither issue-oracle-VALID nor ever solved by any arm — all sympy, an artefact of the rule). Result: `llm-jev` **13/22
[39 %, 77 %]** vs `jev-off-tuned` **12/22 [35 %, 73 %]**, discordance **b = 2 / c = 1** (p = 0.500), correct-by-verdict
13 vs 12 with one discordant loss (`masked`), pooled all-task median wall **1.385× against** (190.7 s vs 137.7 s) and only
0.349× on the 11 both solved — of which 10 are QuixBugs — and **2.68× the cost** ($0.7918 vs $0.2959, 88.4 % of the
candidate's not provider-reported, 2,330 Jev requests against 0). Suite by suite: on the 10 new QuixBugs programs both arms
are 10/10 and 10/10 correct with **zero overfits on either side** — the first evidence the guard thresholds hold on programs
they were not fitted against — and `llm-jev` wins only efficiency (median 3 steps / 34 s / $0.0008 against 6 steps / 79 s /
$0.0026); on the ladder long tier it is 3/8 vs 2/8 at 3.72× the wall and 2.87× the dollars, ending on `replan_stop` /
`max_replans`, not on wall; on the four SWE instances **both arms score 0/4** and `llm-jev` spends 2.94× as much, with
`sympy-16792` alone consuming $0.2178 and 432 Jev requests before the 25-minute cap. The tuned arm's censoring is the
mirror image — 14 of 22 records end at `max_steps`, none at the wall cap — so only the both-solved row is uncensored.

**Reading.** The in-sample 28/28 stands as a measurement and does not generalise as a capability claim. Inside the
one-line-bug regime the mode transfers: same pass, a third of the wall, a third of the dollars, no overfits. Outside it —
multi-hunk ladder work and SWE instances with no issue oracle and no template fitted to them — the extra Jev traffic buys
one ladder task and no SWE instance for about three times the money and time, and the 6/6 SWE figure of the v2 report,
drawn from six issue-oracle-VALID instances four of which the synthesizer had already solved, does not reproduce on four
instances chosen to be free of that selection. Still unmeasured: `llm-sieve` (still `ConfigError`, so criterion 5's
attribution question is open), any repeat run, `LLM_GRACE_MS=0`, the per-question ablation, and a ladder correctness
oracle that is not `perturb.ts`'s own `LADDER_HARNESS`.

## 2026-09-22 — where the out-of-sample wall and dollars went, and iteration 1

Analysis of the 44 out-of-sample runs (`docs/research/llm-jev/oos-analysis-2026-09-22.md`; records in
`experiments/results/oos-2026-09-22-runs.tar.gz`, one directory per run id). Headline corrections to the intuition the head-to-head
invites: **Jev is 2–8 % of the wall** on every suite; **53–60 % is the synthesizer's own in-process enumerate-and-test sweep**
(35,064 shadow test runs on the ladder, 2,228 on SWE, median `tRunMs` 270–1,574 ms); **48 % (ladder) and 60 % (SWE) of generator
sample-seconds are zero-token timeouts** at the ~10 s adaptive deadline re-fired unchanged. Of the 2,330 Jev requests, 707 SIEVE/RANK
requests (64,961 questions, 68 % of the Jev dollars) ranked pools that contained **no passing candidate** — 99–100 % fired in
`plausible = 0` steps, and 13 of 65,076 answers were ≥ 0.5; 454 requests (19.5 %) repeated a `requestHash` already issued in the
same run; `risk|destructive`, `risk|irreversible` and `replan|task_impossible` produced one distinct answer each over 51/51/39
questions. The five ladder-long losses are **generation failures, not selection**: the guard dropped nothing (`arbitrated` false on
every step), four of five never produced one passing candidate over 6,500–13,000 enumerated seeds, and every replan chose
`gather_context` and re-ran the same `pytest` (crossfile: 20 steps with no patch proposed). SWE `sympy-16792` spent its 25 minutes
testing 1,191 of 28,878 seeds; `sympy-20428` self-terminated `complete` on the issue-oracle repro with a patch SWE-bench eval rejects.
On QuixBugs the LLM candidate source contributed **0 of 25 passers**; what transfers is a 9–11-site one-line pool at `tRunMs ≤ 520 ms`
that is fully testable inside one round, so the first passer arrives before any ranking (3 sieve requests across ten tasks). The
two dev-set correctness losses have general causes: `detect_cycle` adds an implicit-`None` exit; `stats` mutates a parameter.

Iteration 1 (branch `oos-iter-1`) implements the analysis's eight ranked changes, none keyed to a task name: SIEVE/RANK gated on
"the pool has a passer inside the run budget" (extend `q17Needed` to SIEVE), a per-run `requestHash` cache, generator deadline
back-off on zero-token timeouts, goal clustering by shared file / call chain (QuixBugs shapes stay one goal), the implicit-`None`-exit
and argument-mutation guard rules, dropping the degenerate question families on the synth path, breaking the `gather_context` replan
loop by forced phase escalation, and no `complete` on an issue-oracle repro alone; plus `bench --archive-runs` so a results
directory carries its records. It is measured on a **fresh** slice, not these 22; the 22 join the development set only after that.

## 2026-09-22 — iteration 1 measured: a fresh 18-task slice, the in-sample 28, and a blocker that is not ours

Full report `experiments/results/llm-jev-iter1.md`, script output `…-iter1.tool.md`, records and their archives under
`bench/results/iter1-{fresh,insample}-*` (branch `bench-iter1`). Build `751e3bf`, jevcode 0.4.0, generator
`openrouter z-ai/glm-5.3-flash`, Jev `jev-1.13.0`, total spend **$0.5798** of a $6 cap.

**0. The shipped default cannot run the synthesizer.** At `751e3bf` an `llm-jev` run never completes a synthesis step:
the SIEVE batch goes out to the lanes, `0 tested on 8 lanes (nothing ran)`, and the wall cap takes the run in step 1 —
five fresh-slice QuixBugs records at `wall_time` with 0–1 steps and `execMs: 0`, and three runs wedged at 0 % CPU with no
child processes for 59 minutes. A five-point $0 offline A/B on one task at `--concurrency 1` pins it on the **warm
verification plane** (`src/synth/warm/`, `7c99ce0` + `6cd0e76`, HARNESS-NEXT wave S1 M6), not on this iteration's work and
not on the bundle: `066816f` 6 steps / 2,896 tested, `168a599` 0/0, `751e3bf` tsx 0/0, `751e3bf` bundle 0/0,
`751e3bf` with `JEVCODE_WARM=off` **6 steps / 2,180 tested in 80.8 s**. ~~`warmModeFor` defaults the plane on for every
`quixbugs` and `pytest` runner.~~ **Re-tensed 2026-09-22 at `d297b29`: that was true AT `751e3bf` and is no longer true of any
tree since `11e1acc` (merged `0556f1a`).** The plane is OPT-IN for every runner: `warmRequested(env)`
(`src/synth/warm/plane.ts:149`) is false unless `JEVCODE_WARM` is `on` / `1` / `true`, and `warmModeFor` returns `null` before
it looks at the runner (`:123`). Everything below therefore ran with `JEVCODE_WARM=off`, which is now simply the default;
the plane's own defects were fixed by `warm-plane-fix-2` and the default stays OFF until pass parity holds
(`docs/DECISIONS.md`, the warm A/B).

**1. Fresh slice (18 tasks: the 8 remaining eligible QuixBugs, the whole new ladder long-2 tier, the first 4 non-sympy
SWE instances that are neither oracle-valid nor ever passed).** `llm-jev` **12/18** [44 %, 84 %] against `jev-off-tuned`
**9/18** [29 %, 71 %], discordance **b = 4 / c = 1**, sign p = 0.1875, correct-by-verdict 11 vs 9, $0.2517 vs $0.2435
(1.03×), 1,086 Jev requests against 0. The four wins are the whole of ladder **long-2** it solves — `deadline_queue`,
`dep_order`, `hunk_merge`, `token_bucket` — a tier authored blind in which no single hunk of any gold diff helps and
seven of eighteen leave a strictly worse tree; the tuned arm is **0/6** there, every task at `max_steps` 30. QuixBugs is
8/8 both ways with zero overfits on either side, and `llm-jev` is *slower* on the 8 both solved (26.0 s vs 19.7 s,
ratio median 1.406, slower on 5 of 8) though a fifth of the cost. SWE is 0/4 against 1/4: all four `llm-jev` runs end
`replan_stop` at **5 steps and 60–100 s** having tested **5 candidates while pricing 6,960** — a faster failure than the
previous slice's, not a better one. `token_bucket` is committed as a strong overfit.

**2. In-sample 28: one regression, `django__django-15128`** (`replan_stop`, 7 steps, 129 s), so **27/28** against the
frozen 28/28 at `066816f`, with correctness unchanged at 26/28 — `detect_cycle` overfit again (a different patch) and
`stats` weak-overfit again. Cost falls hard: **$0.0783 against $0.1441 (0.54×)**, 394 Jev requests against 482,
`candidatesRanked` 867 against `candidatesTested` 32,397; median wall 75.6 s against 63.0 s.

**3. Predictions.** Held: change 1 on QuixBugs (0 ranked) and ladder (7 % of tested); change 2 (`jevCacheHits` = the
`cached` rows exactly, 313 and 68; 0 on QuixBugs as predicted); change 4 (QuixBugs stays one goal on all 18 runs, no
site-budget split ever fired); change 6 (`task_complete` asked 15×/32× against 127, the degenerate families gone);
change 7 mechanically (`gather_context` 70 % against 84.6 %, one forced escalation). Failed: **change 1 on
repositories** (SWE 6,960 ranked / 20 tested); **change 3** — zero-token timeouts are 135 of 290 samples and 3,501 of
5,506 sample-seconds, worse than the 34–39 % it was written to fix; **change 5** — 2 refusals and 1
`adds_implicit_none_exit` over 58 runs, and neither named correctness loss caught. Change 8 has no counter-example here.
Ring 1 **FAILs** the `--jev off` gate (loses `gcd`, `mergesort`, `units`); Ring 2 is 5/5 pass but **REJECT** (Jev
requests up on `units`).

## 2026-09-22 — iteration 2 measured: SWE off zero, the in-sample regression recovered, and a warm plane that is faster and still must stay off

Full report `experiments/results/llm-jev-iter2.md`, script output `…-iter2.tool.md`, records and their archives under
`bench/results/iter2-{fresh,insample,bb}-*` (branch `bench-iter2`). Build `d86c385`, jevcode 0.5.0, generator
`openrouter z-ai/glm-5.3-flash`, Jev `jev-1.13.0`, total spend **$1.0413** of a $4 cap. Same 18 + 28 tasks and the
same limits as iteration 1, so the two are paired task for task.

**0. Read every wall number next to its loadavg.** 15 cores, shared all day with a peer session, a second
continuously-running `jevcode bench` and a 142 %-CPU `tsc`; recorded `loadavg[0]` per record ranges **2.9 to 175**
(iteration 1: 2.4–45). Pass, cost and every counter are unaffected; wall is not, and two task losses (`account`,
`hunk_merge`) are budget casualties that pass in a quieter arm of the same build. One window is load-matched and is
the only timing result quoted: the **back-to-back QuixBugs triple** (warm-off → warm-on → `jev-off-tuned`, 8 tasks
each, 17:46–17:53 Z). It also **corrects iteration 1**: `llm-jev` generates its own load (8 SIEVE lanes ×
concurrency 4), so iteration 1's QuixBugs arm ran at loadavg 4.2→23.2 against a tuned control pinned at 3.1–3.4.
The "26.0 s vs 19.7 s, ratio median 1.406" of that report is a 5–7× load gap as much as a program difference; at
matched load the per-task median is **1.163** (slower on 6/8, at 0.28× the cost).

**1. Fresh 18: 14/18** [54.8 %, 91.0 %] against the tuned generator's 9/18 [29.0 %, 71.0 %], **b = 5 / c = 0,
sign p = 0.0312** (iteration 1: 12/18, b = 4 / c = 1, p = 0.1875); correct-by-verdict 13 vs 9; $0.2489 vs $0.2435.
**SWE moves off zero: 2/4** (`django__django-15375`, `django__django-16100`), and the five-step `replan_stop` that
ended all four iteration-1 repository runs is gone — the three that still stop by replan do so at **14, 17 and 14
steps** having tested **1,060 candidates against 751 priced** (iteration 1: 20 tested against 6,960 priced).
QuixBugs is 8/8, zero overfits. Ladder long-2 is 4/6 again but a *different* four, and a third run of the tier at this build (the back-to-back
warm-off arm) scores **5/6**: across three samples (4/6, 4/6, 5/6) `deadline_queue`, `dep_order` and
`token_bucket` always solve, `route_match` never does, and `csv_schema` and `hunk_merge` flip — so the tier reads
**3 stable + 2 coin-flips** and neither iteration's 4/6 is a level. The shared solves cost a third of iteration
1's steps (`deadline_queue` 9 → 3, `dep_order` 12 → 3). `token_bucket` is a strong overfit in **all four** ladder
long-2 arms run today, always at the same divergence; its rule was never written.

**2. In-sample 28: 27/28 pass, 25/28 correct, with the regression recovered.** `django__django-15128` — iteration 1's only loss, the
case change 9 was written for — ends **`complete` at 6 steps** and passes. The single loss is ladder `account` at
`max_replans` under **loadavg 99–175**, which passes at loadavg 13 in the warm arm forty minutes later (b = 1 /
c = 1, p = 0.75). **`detect_cycle` is gold-identical** — the overfit iteration 1 named for change 5. `stats` is
still weakly overfit and `wrap` picks up a fresh one that is gold-identical in the other arm the same evening.
Cost and Jev traffic rose 2.1× against iteration 1 on a slice whose median loadavg was 88 against 16.

**3. Predictions.** `doneClaimEscalation` fires 8× fresh / 3× in-sample and is what buys SWE and django-15128
(**held**). `rankPoolCap` turns 6,960 priced / 20 tested into 751 / 1,060 (**held**). The deadline high-water mark
is exact — **no goal's deadline shrank after a zero-token timeout in any of six arms** (0 of 45 `llm:deadline`
events) — and zero-token timeouts fall 46.6 % → **27.2 %** of fresh samples and 33.6 % → **6.9 %** in-sample
(sample-seconds 63.6 % → 40.9 % and 46.0 % → 19.8 %) (**held; the residual 27 % is not fixed**). The localiser
fallback **half-holds**: Ring 1's QuixBugs `--jev off` gate now passes (`gcd`, `mergesort` recovered) with the
plane off *and* on, but the ladder gate still fails on `units`, so Ring 1 is red. Ring 2 is 5/5 pass, REJECT.

**4. The warm A/B: faster, safe as a transport, and it loses tasks — keep the default OFF.** Over 93,460 offered
screens in seven warm-on arms: **0 fallbacks, 0 restarts, 0 screen:mismatch, 0 `disabledReason`, 0 wedges**;
iteration 1's `nothing ran` / `LaneError` signature never appears, and Ring 1 with the plane on completes in
12.5 min where iteration 1 had to kill it. At matched load warm is **23 % faster** (median per-task ratio
**0.767**, faster on **7/7** both-solved; 207.8 s → 154.6 s) with the S0 bucket shares unchanged. But warm-on
loses QuixBugs tasks cold solves — `topological_ordering` **twice independently** (loadavg 150 and 35) and
`shortest_path_length` once, 4 cold-wins against 2 warm-wins over 54 paired tasks (the two ladder pairs are at
parity: 5/6 both ways in the back-to-back pair, both missing only `route_match`). The cause is a calibration
defect, not the transport: `src/synth/sieve/runner.ts:847` teaches `tRunMs` from cold runs only, and with the
plane on the only candidates reaching the cold path are those whose hot screen hit a deadline (`:740-750`,
`newDeadlineHit` → `deadlineRecheck()`), so the sample is **nothing but timeouts** — `run median 11,655 ms`
against 510 ms cold on the same batch — `refineTRun` writes it into the run plan, `runs left` collapses 1,315 → 16
and every later batch reports `0 tested (nothing ran)`. Fix that (and give `warm.serve` the adapted per-case
timeout instead of the lane run cap, `:736`) and re-run the matched pair before flipping the default.
Also recorded: `JEVCODE_WARM=on` is a **no-op on SWE-bench** — `warmModeFor` admits only the `quixbugs` and
`pytest` runners and the SWE oracle's runner is `other` — so the A/B covers 14 of the 18 tasks, and nothing in the
output says so. And the warm counters live **only** in the live `transcript.log`, which `--archive-runs` does not
copy (`src/synth/search/types.ts:129-141`); every warm number above was harvested by hand.

## 2026-09-22 — the `jev-on-next` arm: what the LLM-loop wave will be measured with (no rows yet)

Plumbing only, from `docs/LLM-LOOP-DESIGN.md` §8; **nothing live has run**. This entry exists so the arm is
pre-registered before it produces a number, which is the whole point of §8.4's RETIRE rule.

**The arms.** `jev-on-next` is the `jev-on` engine — the generator still proposes — with three mechanisms on: the §2
router table, the §3 S2 generation path (one hedge per round at `clamp(2 × TTFB p50, 3 s, 8 s)`, the byte-stable
prefix, a 256-token reasoning cap on the cheap classes) and the §4 bounded sieve fast path armed (`fastPath: 'auto'`,
the structural predicate decides per step). Its generation parameters are the `jev-off-tuned` object — max_tokens
1,500, `{effort: 'low'}`, a 20 s per-sample deadline (30 s on repositories), doubled once after a `length` stop — plus
the pinned S2 block, all recorded in `summary.json.conditions[arm].generation`. **`jev-on-next-nofast` is the same arm
with the fast path off**, and it is not optional: without it a `jev-on-next` win confounds tuned generation, S2, the
routers and the fast path all at once, and §8.5 clause 4 rests on it. Both arms refuse to run at anything but
`--concurrency 1` (the fast path runs test commands inside the step; at concurrency 4 its wall is a statement about
how busy the machine was). Neither is an `EngineMode`: `engineModeOf` maps both to `jev-on`, exactly as
`jev-off-tuned` maps to `jev-off`.

**What it is read against.** The recorded rows of `experiments/results/llm-jev-iter1.md` — fresh 18: `llm-jev`
**12/18**, `jev-off-tuned` **9/18**, with `llm-jev` 26.0 s against tuned's 19.7 s on the 8 both-solved QuixBugs tasks;
in-sample 28: `llm-jev` **27/28**. They are merged by `(suite, task, condition)` and **not re-run**. They are also
**not a same-build baseline**: they were taken at `751e3bf`, and `main` has since taken the nine changes of
`oos-iter-2`, none of them measured. Every comparison against them confounds this wave with all of iteration 2, which
is why the `jev-on-next-nofast` control and a plain `jev-on` arm are the only contrasts §8.5 leans on. If
`oos-iter-2` is measured on the same 18 + 28 first, those rows replace the `751e3bf` ones and the confound goes away;
that ordering is preferred.

**What is measured.** Five blocking rows (§8.3), all computed by `src/bench/next-arms.ts` from
`BenchRecord.synth` — which now carries the wave's facts because `src/bench/step-records.ts` folds them out of
`steps.jsonl` (§5.5; without that bridge every `fastPath` and `router` field is written to the run directory and is
invisible to every table). R-a: `routers.waitMs` 0 on every step — a router that made the loop wait has gated it.
R-b: `fastPath.wallMs <= budgetMs` on 100 % of fired steps. R-c: stage-2 declines over stage-1 fired, **per suite**,
≤ 0.3 — above it the predicate is wrong, not the budget. R-d: the per-reason decline histogram, exhaustive over
`FastPathReason`, no `'error'` bucket over 5 % — R-c says the predicate is miscalibrated, R-d says which clause did
it, and a ratio alone does not name the mistake. R-e: `riskSource: 'code'` and `jevUnavailable` counts, reported; a
harmful command allowed under a dropped ask reverts the §2.4 ratification on its own.

**Two readings pinned, because the design's prose leaves them open.** R-a is written as a p95 with a bar of exactly
zero; the table takes the **maximum**, which is the same gate unless more than 5 % of steps blocked and is the form a
single blocked step cannot average its way out of. R-c is written as "stage-1-fired / stage-2-declined ≤ 0.3", a ratio
that *rises* when the predicate works; the table takes **`stage2Declined / stage1Held`**, the direction in which the
stated conclusion ("the predicate is wrong") is the one the number supports. `stage1Held` is the count of rows the
writer recorded at `stage: 2` — the steps that reached the expensive stage at all. A *stage-1-fired* denominator is
a shape no run produces (the writer sets `decision: 'fired'` only on a successful proposal, always at `stage: 2`),
which would make R-c unfailable, prediction (e) permanently `not_evaluable`, and R-b blind to a round that overran
its budget and then timed out.

**The accept rule** (§8.5) is five clauses, evaluated by the same module and printed by
`experiments/llm-jev/headtohead.mts` under `--candidate jev-on-next --control jev-on-next-nofast`. Clause 1 (the §7
gates, including Ring 1 under `--jev off`) is a tree fact the script cannot observe: it is `--gates green|red` and
defaults to **not measured**, which does not accept. Clause 4 has the documented escape — retire route R9 and ship S2
+ routers alone with `fastPath` defaulted `'off'` — and prediction (a) or (e) failing takes that branch, but only
when (f) itself was EVALUATED and lost: a missing control leaves clause 4 `not_evaluable`, so a wave with no
same-build contrast cannot read ACCEPT. **A failure retires the route; it does not loosen the predicate.** Clause 5
is reported, not checked: it prints R-e's two counts for the §2.4 judgement and makes no machine assertion about
them, which is what its title now says.

## 2026-09-22 — iteration 3 (implemented; Ring 1 measured, then reviewed and cut back)

Branch `oos-iter-3` from `d86c385`, after the adversarial review of `c469c9e`
(`/tmp/review-iter3-2026-09-22.md`, 16 findings). **The only thing measured on this build is the Ring-1 gate below**
($0, offline, mock provider); every other number comes from the iteration-1 records replayed offline (the archived
`decisions.jsonl.gz` / `steps.jsonl.gz` / `model_patch.diff.gz` of each `bench/results/iter1-…` run, and
`~/.jevcode/runs/20260922-013715-nlsygcax`) or from a code sweep of `bench/data`. No pass, wall or cost number for
the mode is claimed here.

**1. `late_guard` — kept as a lone-passer signal, WITHDRAWN from the pool rule.** A guard CLAUSE (an `if` with no
`elif`/`else` whose body leaves the suite) is late when a preceding sibling DEREFERENCES its operand's exact dotted
path — `p.attr`, `p[…]`, `p.method(…)`, a use the rejected value would make fail — and nothing in front BINDS that
path's root and nothing in front NARROWS it with an exiting guard of its own
(`src/synth/py/structure.ts` `guardClauses` / `isLateGuard` / `OperandPlacement`, differenced by
`src/synth/search/guard.ts` `newlyLateGuards`).

The review killed the shipped version: its shape (b) ("nothing in front binds it, so it could stand at the top")
degenerated to "not the first statement", because nothing ever binds a parameter; and its shape (a) counted any
occurrence of the operand ROOT, so `self.logger.debug(…)` was evidence about `self.handler`. It fired on
`bench/data/swebench-verified-30.gold.json` → `sympy__sympy-17139`, a real gold, and on seven other correct shapes.
All of those are now silent (`test/unit/synth/search/late-guard.test.ts`, 16 cases + the sympy gold).

The sweep, and it is the reason the signal lost its pool role:

| corpus | patches | `late_guard` fires |
|---|---|---|
| QuixBugs golds | 41 | **0** |
| ladder golds | 65 files, 26 tasks | **0** |
| SWE-bench Verified golds (`swebench-verified-30.gold.json`, the four fresh django ones included) | 92 Python hunks / 30 instances | **0** |
| iteration-1 recorded overfits (`stats`, `token_bucket`, `detect_cycle`) | 3 | **0** |

The last row is the finding. `stats` binds `ordered` in front of the guard; `token_bucket`'s prior statement only
plain-reads `cost`; `detect_cycle` never dereferences `hare.successor.successor` in front. A signal with no positive
evidence on the records cannot be the evidence that a pool holds no gold, so `POOL_SUSPECT_SIGNALS` is now
`{mutates_new_argument}` alone and `late_guard` only ever triggers the lone-passer Q16 advisory, which drops nothing.

**2. The gold-free-pool rule, re-specified.** `decide` still computes the signals for every contender and still
skips the three code RANKING rules when every contender carries a swept signal — but: the refused pick is HELD as
`st.suspect`, exactly as on the lone path, so the budget-reserve release and step-end `commitSuspect` apply to it
(the old `dropped` was strictly harsher than the rule it claimed to copy — the same `stats` candidate at 0.49 was
held-then-committed alone and killed outright in a pool of two); the pool ask is gated on `jevRequestsLeft`, and with
none left the code rules decide with `requests: 0` (it used to overspend the budget or throw); a missing or non-Noul
answer for the pick falls through to the code rules instead of refusing every contender at `p = 0`; and only a SWEPT
signal counts toward `STRONG_SIGNALS_MIN`, since `adds_special_case` rides on every inserted guard and made the 0.3
branch dead. `preferLlmInCluster` still fires first and is untouched.

**3. The signals are NOT shown to Jev.** `arbitrateState` is back to the measured five keys. The 0.3 / 0.7 bounds
were calibrated on a signal-free state and `adviseLonePasser` still asks on one, so gating them on a Noul asked over
a state that names a candidate's suspicious properties compares against a number nobody measured — and an annotation
present on some options and absent on others reads as "not computed" rather than "clean". The signals stay code-side.

**4. Q16 wording.** The `true` example is "a missing guard added in front of the code that uses the value" — the
name-match clause is gone, because `stats`' own gold guards the parameter `values` while the failure is an
`IndexError` on the derived local `ordered`, and guarding the parameter while the traceback names a derived local is
the majority shape. The `false` counter-example is "a guard on a variable that is not on the path from the failing
input to the failure". Both sides keep ≥ 2 examples, nothing counts, no 0.5.

**5. `JEVCODE_DEADLINE_GROWTH=served|always`, default `always`.** The review showed the shipped `served` arm could
not raise a deadline at all — `growths` never incremented and `floorMs` only records a latency a sample BEAT, so it
can never exceed the deadline that sample ran under; the arm was "no timeout backoff", not "served evidence", and
the test that appeared to show growth pinned `deadlineMs: 1_000` on `fire`, an override the bench never uses. It now
means what it says: a zero-token timeout backs the deadline off only once the provider has actually SERVED a sample
of that goal (`end.kind === 'result'`). Measured through the real `fire` path, deadlines scaled to ms:

| provider | `served` | `always` |
|---|---|---|
| never answers | 20, 20, 20, 20 (growths 0) | 20, 30, 45, 68 (growths 4) |
| answers once, then times out | 20, 30, 45 after the served round | identical |

`always` is byte-identical to iteration 2. The arm is recorded, not logged: `LlmTrace.deadlineGrowth` →
`StepRecord.verify.deadlineGrowth` → `StepsSummary.deadlineGrowth` (`tasks.jsonl` `synth`).

**6. The three `--jev off` localiser holes, and a fourth the review found.** (a) the escaped code order was cut at
`anchorsPerFunction` = 3, a bound measured on a Jev ranking — `escapedAnchors` (40) applies on the escaped branch
only; (b) `codeDerivedFunctions` and the unaffordable tail of the line beam were gated behind the very budget whose
exhaustion they exist for; (c) `q5Anchors` dropped every replace site with no `jevProbability`, so an all-escape
localisation had no replace site at all. **(d) review finding 5:** that `evidenced` test was GLOBAL, so the fallback
died the moment any one Choice answered — the normal Jev-on case. It is now decided per function group: on a mixed
localisation the answered group keeps its measured top-3 and the escaped group keeps its whole code order.

**Review finding 7, stated honestly:** a Jev-ON trajectory is **not** unchanged when the budget is spent mid-beam.
It was never claimed to be by the code, only by the commit message. Measured on `review.test.ts`'s budget-1 SBFL
case: main `sites=11`, geometry replace order `17,16,15,14`; this branch `sites=14`, order `17,14,15,16`. That is
accepted — Jev routes, it never gates, and a function the router could not afford an opinion about must still be
searchable — and it is now pinned rather than denied.

**Review finding 12:** `escapedAnchors` also grew what reaches the MODEL. `listingsFor` fed every site to
`listingSet`, so one escaped function's anchors could crowd a second located function out of the four `## Code`
listings entirely. The site list keeps its 40; the prompt anchors are capped at `anchorsPerFunction` per located
function. Note that under `REPLACE_SITES_MAX = 6` in file order the widening still cannot rescue `kth` — **iteration
4 owns the no-Jev site ranking.**

**Review finding 15:** `guardClauses` is memoised per (module, block), so an 8-contender decision no longer repeats
an O(n²) suite walk eight times on a repository-class file.

**Ring 1, the one thing here that IS measured** (offline, $0, mock provider, at `6e22007`; the four arms of
`experiments/harness-next/quick.mts ring1` run by hand at `--concurrency 2/3` because a live bench held the machine at
load 40–130 all morning, which is also why the Jev-ON reference arm is noisy):

| task | Jev on | Jev off | verdict |
|---|---|---|---|
| `gcd` | pass, 6 steps / 110.7 s | pass, 6 steps / 168.7 s | **kept** (only slower, 1.52×) |
| `kth` | pass, 8 steps / 366.3 s | **fail**, `max_replans`, 17 steps | **LOST** — the one remaining Ring-1 loss |
| `mergesort` | fail, `replan_stop`, 10 steps | not run (the Jev-on arm did not solve it) | vacuous |
| `tagcloud` | pass, 2 steps / 8.1 s | pass, 2 steps / 3.8 s | **kept** |
| `units` | pass, 4 steps / 83.5 s | pass, 5 steps / 188.7 s | **kept** (only slower, 2.26×) — was the iteration-1 loss |

So the ladder half of the gate is **green** (on 2/2 → off 2/2) where iteration 1 lost `units`, and the QuixBugs half
still fails on `kth`. The first `--jev off` run of `kth` with these fixes does reach replace sites in the code order
(it visited none at all before), but `REPLACE_SITES_MAX` = 6 and the SEEDS cut take the first six in file order and
`kth`'s gold is the tenth code line of its only function, so the site the fix made available is not one the step
reaches. **That cut — a site budget justified by a Jev ranking's quality, applied where there is no ranking — is the
next point, and it is not one of this iteration's four items.**

**What Ring 1 caught in this branch's own work.** The first run of the ladder arm at `33279b2` read "every passer of
the batch is structurally suspect and the pick `composite/donor_body_unit:parse_size:2stmt` (deletes_statement,
adds_special_case) answered general 0.50 < 0.7; dropping the 3 passers" and `replan_stop`ped `units` **with Jev ON**
at 15 steps. `deletes_statement` fires on a gold-shaped REWRITE, and the `units` gold IS a rewrite. Membership of
`POOL_SUSPECT_SIGNALS` is now "swept against the golds and found on none of them" — and after the review's sweep
that is `mutates_new_argument` alone. That is the whole reason to run the gate.

**Tests, labelled by what they actually establish** (review finding 16: a test that fails on main only because the
symbol did not exist is not a failing-first record):

*Failing-first by mechanism* — fails on `d86c385` src with the symbol present, for the reason the fix names:
`sites.test.ts` "no Jev probability anywhere still yields replace sites" and "a MIXED localisation keeps the escaped
group's code order"; `jev-off-fallback.test.ts` kth-L12 / mergesort-L17 and the spent-budget case;
`review.test.ts` "budget 1 with SBFL: the starved beam contributes its code order" (main: 11 sites / 17,16,15,14);
`deadline-growth.test.ts` the two provider probes and the emit-string case; `gold-free-pool.test.ts` finding 2's
alone-vs-pool identity, finding 6's spent budget and finding 11's escaped Noul; `llm-adapter.test.ts` "one escaped
function cannot crowd another out".

*Regression pin* — passes on main and must keep passing: `sites.test.ts` "a Jev that DID answer keeps the
top-3-per-function cut"; the whole of `guard.test.ts`, which is restored to its `d86c385` text and passes unchanged
against this branch's `src` (the only diff is the Q16 snapshot); `late-guard.test.ts`'s 16 correct shapes and the
`sympy__sympy-17139` gold, which is the review's own counter-example.

*Fixture property* — asserts what the corpus contains, not what the code does: `late-guard.test.ts`'s three sweep
cases and its corpus-coverage case; `gold-free-pool.test.ts`'s Q16 wording cases.

Files: `src/synth/py/{structure,index}.ts`, `src/synth/search/{guard,llm,sites,subgoal,index,types}.ts`,
`src/synth/llm/source.ts`, `src/synth/localize/{index,types}.ts`, `src/bench/{step-records,types}.ts`,
`src/core/types.ts`. Flag: **`JEVCODE_DEADLINE_GROWTH`** (`served` | `always`, default `always`).

## 2026-09-22 — iteration 4 (implemented, unmeasured)

Branch `oos-iter-4` from `5ac0042`. **Nothing here is a pass, wall or cost measurement of the mode.** Every number
below comes from a code sweep of `bench/data` (198 gold patches), from an offline replay of the recorded
`bench/results/iter1-*` and `~/.jevcode/runs/20260922-*` runs, or from the Ring-1 arms at the end — and those arms ran
while another live bench held the machine at load 79–118, so they are reported, not gated. Four items: the no-Jev
replace-site order (the `kth` loss iteration 3 handed over by name), the data-flow signal the iteration-3 author asked
for, the gold sweeps of the three signals nobody had swept, and the lone-vs-pool bound asymmetry.

**A. The replace-site order when there is no Jev ranking** (`src/synth/search/sites.ts`, `subgoal.ts`).

The mechanism, exactly. With no Choice answered — `--jev off`, the request budget spent mid-beam, or every line
Choice escaped — every `ScoredReplace.jev` is 0 and every `sbflRank` is `+Infinity`, so `buildGoalSites` step 4's tail
comparator `a.sbflRank - b.sbflRank` evaluates `Infinity - Infinity` = **NaN**. V8 reads a NaN comparator as "equal",
`Array.prototype.sort` is stable, and the six `REPLACE_SITES_MAX` keeps are therefore the first six lines of the file.
`kth`'s gold is `return kth(above, k)` on L12, the tenth code line of its only function counting the `def`, so the
replace site iteration 3 finally made available was thrown away one layer down. Recorded run
`20260922-155658-35hfmbqm`: nine sites, every one an insert gap, `plausible 0` on every step, `replan_stop` at 11, and
`grep -ic sbfl transcript.log` = 0 — there was no coverage in that run at all.

Two things were wrong, not one. The second: Q5n is asked on every single-file workspace, and `JEVCODE_JEV=off`
answers a Noul with the **inert 0.5** (`src/jev/off.ts`). `buildGoalSites` took that as evidence, gave the first three
lines of the file `jev = 0.50` and ordered them ahead of everything the code had to say. A Q5n whose every line
carries one value ranks nothing, whoever produced it, so a flat answer is now ignored with a note — the same argument
`q5Anchors` already makes about the escape ("`p ≥ minP` is a filter on an answer; it cannot also mean *no answer at
all*").

The order (`orderByCodeEvidence`), built only from evidence already in reach:

1. the failing call's function first, then its callees (`callDistance`, from `FailureView.call` and `mod.functions[].calls`) — as the grouping the round-robin rotates over;
2. overlap with the failure's own words (`failureVocabulary`: `testLiterals` ∪ `taskIdentifiers` ∪ the identifiers of each failure's call / expected / actual, Python keywords and builtins dropped), distinct whole tokens on the line, descending;
3. the statement-kind prior measured below, descending;
4. line order, so the result is total and stable;
5. then **round-robin across function groups**, so one function cannot take all six;
6. and, ahead of all of it, **a continuation physical line is ranked last** — the statement-span site covers it.

SBFL is unchanged and still leads: the tail is split into the rows the spectrum ranked (sorted by rank, exactly as
before) and the rows it said nothing about (this order).

**The scope of the change, corrected** (review defect 3). The first version of this entry said "a Jev-ON trajectory
with a real ranking is byte-identical". **That is withdrawn: it is false.** `Infinity - Infinity` is not the no-Jev
case — two tail sites share `+Infinity` whenever the spectrum ranked neither, which is routine with full coverage and
a full Jev answer, because `statementSiteFor` spans start at a statement's first line and that line usually has no
spectrum row of its own. The reviewer's probe (one file, a real Q5 Choice, a real non-flat Q5n, a real spectrum) goes
`9,10,8,3,6,2,5` on `5ac0042` and `9,10,8,3,6,5,2` on the branch, and at `REPLACE_SITES_MAX = 6` the **kept set
differs**: main keeps L2, the branch keeps L5. The true claim is narrower: a finite rank still sorts exactly as it
did and still beats an infinite one, so **the only order that changes is the relative order of tail sites the
spectrum did not rank — in every run, Jev-ON included.** `code-order.test.ts` pins a Jev-ON mixed finite/infinite
case (`9, 8, 3, 6, 5, 2`, where L5 wins on sharing the test literal `1`) as a deliberate behaviour change, labelled
as such. `sites.test.ts`'s `[9, 7, 15, 8, 2, 4]` and `[9, 8, 15, 2, 4]` pins, the `test/fixtures/loop/*golden*`
fixtures and the iteration-3 starved-beam pin in `review.test.ts` all still pass — they simply have no two
infinite-rank tail sites, which is why they never showed this.

**Consequence for the next measurement:** the Jev-ON arms are NOT a no-op re-run of `5ac0042`, so the iteration-3
Jev-ON baseline is not comparable.

**The statement-kind prior, re-measured over all 198 patches** (review defects 2, 6 and 7 — the first version of
this table covered 155 of 198 and gave `continuation` a prior above `return`).

Two corrections. **(a) All 198 are analysable.** 43 SWE-bench hunk images do not tokenize after a plain dedent,
because `hunkPatches` cuts a window out of the middle of a file: 19 `unindent does not match any outer indentation
level`, 18 `EOF in multi-line string`, 6 `EOF in multi-line statement`. `gold-corpus.helpers.ts analysableImage`
recovers **43 of 43** with an `if True:` prologue at every indent width the fragment uses (a fixed 1-space ladder is
not enough — `sympy-15345`'s window runs 20 → 8 → 4) plus a closing `"""`/bracket tail, all outside the patch text.
**(b) A rewritten multi-line statement counts ONCE, at its first line, on both sides.** Counting every physical line
of one gave `continuation` 1.71, above `return` 1.68, so the order offered `* rate` as a replace site ahead of the
`return (` that owns it — a syntax error waiting to happen, and exactly what the statement-span site exists to
prevent. With statements counted once the kind is gone from the table, and `orderByCodeEvidence` ranks a
continuation physical line LAST rather than scoring it.

195 gold statements against 2,335 background statements, so r0 = 195/2335 = **0.0835** (was 0.0742). The smoothing is
unchanged and still fixed by the measurement: one pseudo gold statement on top and, on the bottom, the
1/r0 = 11.97 background statements one gold statement is worth at the base rate, so
`prior(k) = ((gold_k + 1) / (bg_k + 1/r0)) / r0`, and a kind the corpus never showed lands on exactly 1.00.

| statement kind | gold stmts | background stmts | raw rate | smoothed rate | **prior** | was |
|---|---|---|---|---|---|---|
| `while` | 3 | 15 | 20.0 % | 14.8 % | **1.78** | 1.89 |
| `return` | 70 | 473 | 14.8 % | 14.6 % | **1.75** | 1.68 |
| `break` | 1 | 5 | 20.0 % | 11.8 % | **1.41** | 1.46 |
| `assign` | 53 | 502 | 10.6 % | 10.5 % | **1.26** | 1.14 |
| `augassign` | 3 | 33 | 9.1 % | 8.9 % | **1.06** | 0.95 |
| `for` | 7 | 91 | 7.7 % | 7.8 % | **0.93** | 0.95 |
| `assert` | 0 | 1 | 0.0 % | 7.7 % | **0.92** | 0.93 |
| `expr` | 33 | 473 | 7.0 % | 7.0 % | **0.84** | 0.45 |
| `if` | 22 | 333 | 6.6 % | 6.7 % | **0.80** | 1.28 |
| `continue` | 0 | 4 | 0.0 % | 6.3 % | **0.75** | 0.77 |
| `try` | 0 | 7 | 0.0 % | 5.3 % | **0.63** | 0.73 |
| `except` | 0 | 8 | 0.0 % | 5.0 % | **0.60** | 0.69 |
| `import` | 0 | 9 | 0.0 % | 4.8 % | **0.57** | 0.60 |
| `elif` | 0 | 11 | 0.0 % | 4.4 % | **0.52** | 0.57 |
| `other` | 2 | 91 | 2.2 % | 2.9 % | **0.35** | 0.42 |
| `else` | 0 | 24 | 0.0 % | 2.8 % | **0.33** | 0.37 |
| `raise` | 0 | 52 | 0.0 % | 1.6 % | **0.19** | 0.21 |
| `from_import` | 1 | 203 | 0.5 % | 0.9 % | **0.11** | 0.12 |
| `continuation` | — | — | — | — | **gone** | 1.71 |

Per corpus, the gold statements behind it: QuixBugs 37 (`return` 10, `assign` 8, `if` 7, `expr` 4, `while` 3,
`for` 3, `augassign` 1, `other` 1); ladder 67 (`return` 35, `assign` 18, `if` 8, `expr` 4, `for` 1, `augassign` 1);
SWE-bench Verified **91** (`assign` 27, `return` 25, `expr` 25, `if` 7, `for` 3, `other` 1, `from_import` 1,
`augassign` 1, `break` 1) — 57 before the recovery, so the only real-world corpus now carries 47 % of the
measurement instead of 35 %. The two movements that matter are **`if` 1.28 → 0.80** and **`expr` 0.45 → 0.84**, both
driven by the recovered SWE-bench hunks; `while` (3 golds) and `break` (1) remain thin cells that the smoothing
holds near the base rate. `code-order.test.ts` re-derives the whole table from `bench/data` and checks the **rank
order plus a ±0.15 tolerance** rather than exact equality, so adding a ladder task is no longer a src change
(review defect 13); `signal-sweeps.test.ts` derives its patch count from the corpus for the same reason.

**`kth` under `--jev off`**, through the real localiser and `buildGoalSites` on the recorded run's own task text and
failure: the six replace sites are **`L10, L12, L14, L2, L3, L4`** — the two lines naming `kth` (the task's own
backticked identifier) first, then the remaining `return`, then the assignments in line order (`if` now scores below
`assign`). On `5ac0042` the same inputs give **`[2, 3, 4, 6, 7, 9]`** — review defect 8: the earlier entry said
`[2, 3, 4, 10, 12, 14]`, which has the gold L12 inside it and contradicted both the measurement and this branch's own
test. The gain is therefore larger than the first write-up claimed: on main the gold was not in the six at all, and
it is now reached second.

**WIDENED.** `sites.every(seedsExhaustedAt)` is the right gate for a site budget a Jev RANKING chose. With no
ranking the six are a code ORDER and `REPLACE_SITES_MAX` is a cut justified by "a Jev top-3 covers 36/40", so
running it out exhausts the order, not the space; `widenedReachable` adds that every REPLACE site being spent is
then enough, gaps or no gaps. The recorded `kth` run parks in phase `LLM` with its gaps still open and never reaches
WIDENED.

**The test for "Jev had no opinion" is `jevRankedSites`, not `evidence.jevProbability`** (review defect 4).
`jevProbability` is written ONLY by Q5 anchors, while the ranking the single-file path actually uses is the Q5n
Noul, which lives in `GoalSites.lineNouls` and reaches a site only as its `q5n noul 0.xx` note. So a goal whose line
Choice escaped — which the branch's own `kth` record shows four times — but whose Q5n answered **0.90 and
short-circuited** carried no `jevProbability` anywhere and took the new clause: WIDENED opening early on a goal Jev
was as confident about as it ever gets, with five insert gaps still unspent. The predicate now reads both, and a
flat Q5n (the `--jev off` inert 0.5) leaves no note, which is exactly the split the clause needs.
`code-order.test.ts` pins the reviewer's probe: short-circuit → gate false; flat → gate true.

**Flat Q5n** (review defect 5). `const flat = new Set(r.probs.values()).size <= 1` put the `size > 1` test on the
NOTE and not on the RULE, so a function with exactly one code line produced one Noul, read as "flat", and was
dropped silently — measured on `def scale(v, k): return v * k` with Jev answering 0.95, the L2 short-circuit
disappeared where `5ac0042` had it. Now `r.probs.size > 1 && new Set(...).size <= 1`. The reviewer also settled the
empirical question: over 1,180 runs and 903 Q5n request groups, **401 groups are flat and every one is exactly
0.5**, all in runs whose every Noul is 0.5 — so every flat Q5n on record is the `--jev off` inert answer and a real
Jev never returned one.

**B. `guards_derived_local` — the data-flow signal, and why it ends the iteration lone-passer-only**
(`src/synth/py/structure.ts` `parameterDerivedLocals` / `guardsDerivedLocal`, differenced by
`src/synth/search/guard.ts` `newlyDerivedLocalGuards`).

The iteration-3 author's disagreement 1, as code. A function's contract is about its PARAMETERS, so a guard on a
parameter is a precondition and belongs at the top; a guard on a value the function computed for itself, placed
behind a use the guard does not protect, is a patch for the one path the tests took. Precisely: for at least one
operand path P of a guard clause the patch ADDS, with root R — R is a `parameterDerivedLocals` name of the enclosing
`def` (bound to a fixed point from an expression reading a parameter, never a parameter itself); a statement
UNCONDITIONALLY reached before the clause BINDS R; and a statement unconditionally reached before the clause uses P
in a way **the value the clause rejects would have made fail**.

**Two corrections from the review, and they are iteration 3's `late_guard` lesson at one remove.**

*Defect 1a — a use that cannot fail is not evidence, and what "fail" means depends on what the clause tests.* An
`X is None` clause is broken by any dereference (`P.attr`, `P[…]`, `P(…)`). A truthiness/emptiness clause
(`not X`, `if X:`, `len(X) == 0`, `X == []`) is not: `items.sort()`, `s.lower()`, `cfg.get(k)` and
`rows.append(1)` all succeed on an empty container or string. Since "add `if not X:` in front of the indexing that
crashed, behind a harmless method call" is the commonest shape of a real `IndexError` fix, the old rule called that
whole family an overfit. The clause kind is now read off the condition (`GuardClause.tests`), and an emptiness
clause requires a use an empty value breaks: subscripting, `.pop()`/`.popleft()`/`.popitem()`, `min`/`max`/`next`,
or tuple unpacking.

*Defect 1b — a branch not taken is not "in front of".* `before` was
`statements.filter(s => s.blockIndex === block.index && s.startLine < g.line)`, and `blockIndex` is the enclosing
DEF, so a use inside an unrelated `if` branch, an `else`, a `try` whose `except` already handles the empty case, or
a `while` body all counted. `GuardClause.preceding` is now the clause's own preceding siblings (headers only) under
everything the enclosing suites unconditionally ran to get there.

All **14** correct shapes both reviews list are silent, and the rule is not vacuous — a NONE clause behind a
dereference, an emptiness clause behind `ys[0]`, `min(ys)`, `ys.pop()` or `a, b = ys` all still fire, and the same
prior use is evidence for `if o is None:` and not for `if not o:` (`signal-sweeps.test.ts`).

| corpus | patches | analysable | `guards_derived_local` fires | **sweep POWER** (patches that could fire) |
|---|---|---|---|---|
| QuixBugs golds | 41 | 41 | **0** | 2 |
| ladder golds | 65 files, 26 tasks | 65 | **0** | 4 |
| SWE-bench Verified golds | 92 hunks / 30 instances | 92 (43 recovered) | **0** | **0** |
| **total** | **198** | **198** | **0** | **6** |

**The replay, and it reverses the iteration's headline result:**

| record | at b3c28a0 | now | why |
|---|---|---|---|
| ladder `stats` | FIRED | **no** | the only use in front, `return float(ordered[mid])`, sits inside `if len(ordered) % 2:` — a branch the EMPTY input never takes, so on the failing path nothing had touched `ordered` before the guard. What is left (`mid = len(ordered) // 2`, `if len(ordered) % 2:`) cannot fail on an empty list |
| QuixBugs `detect_cycle` | FIRED | **no** | the clause tests `hare.successor.successor` for truthiness and what stands in front is `if hare.successor is None:` — a dereference of `hare`, which a falsy `hare.successor.successor` would not have broken |
| ladder `token_bucket` | no | **no** | unchanged: the overfit and the gold guard the same two parameters |

So: **0 of 3.** Under the bar — a clean sweep **with stated power** plus a replay record where the signal separates
an overfit from its gold — `guards_derived_local` is exactly where `late_guard` stood in iteration 3: clean on the
golds, silent on the records, power 6 of 198. It is **LONE-PASSER ONLY**, and `POOL_SUSPECT_SIGNALS` is
`{mutates_new_argument}` — iteration 3's set. **Iteration 4 adds no pool signal.**

**What that means for `detect_cycle`, stated plainly.** Its class A′ guard pools are **NOT** gold-free: no
contender carries a swept signal, so `poolSuspect` is false and `probe_majority` commits a guard at L9 with no Jev
request while the gold replaces L5. That is the hole `20260922-013715-nlsygcax` showed, it is **still open**, and
`guard.test.ts` now asserts it rather than claiming it is closed. The data-flow property is real and the signal is
worth having on the lone path; what it does not have is a record proving it separates an overfit from a gold, and
this iteration's attempt to claim one rested on two uses that could not fail.

**C. The three unswept signals** (`duplicates_block`, `guards_other_variable`, `dead_guard`). These were in
`SuspicionSignal` from the start and no sweep had ever been run on them. It found four gold fires, each a concrete
false positive:

All 198 patches are analysable after the recovery, and the POWER column is the review's demand (defect 2): how many
patches could fire at all. For these three it is much wider than `guards_derived_local`'s 6, so their clean sweep is
the stronger evidence of the two — what they lack is the other half of the bar.

| signal | QuixBugs 41 | ladder 65 | SWE 92 (all analysable) | fires as it stood | after the fix | sweep power |
|---|---|---|---|---|---|---|
| `guards_other_variable` | 0 | 0 | 0 | clean | **0** — stays lone-passer-only | 51 of 198 add a guard subject |
| `dead_guard` | 1 — `topological_ordering.py` | 0 | 2 — `sympy__sympy-17139`, `pytest-dev__pytest-10081` | 3 fires | **0** — stays lone-passer-only | 51 of 198 |
| `duplicates_block` | 0 | 0 | 1 — `sympy__sympy-12489` | 1 fire | **0** — stays lone-passer-only | 198 (any patch adding ≥ 2 lines) |

The three fixes, each with the gold that forced it:

- `guardSubjectsIn` read the `in` of `nextnode not in ordered_nodes` as a guarded name, because `NOT_GUARD` matches
  `not <NAME>` and `in` is a NAME. The QuixBugs gold `topological_ordering.py`, whose whole patch is
  `outgoing_nodes` → `incoming_nodes` **inside exactly that condition**, then fired `dead_guard` — nothing in the
  function dereferences a variable called `in`. A subject whose head is a Python keyword is not a subject.
- `dead_guard` asked only "is the subject dereferenced anywhere in the function". `sympy__sympy-17139`'s gold guards
  `rv.exp.is_real`, a predicate attribute `_f` never names at all, and `pytest-dev__pytest-10081`'s guards `skipped`,
  a local the patch itself introduces two lines above its own guard. "Nothing reads it" is evidence only about a value
  the code HAS: the subject must now OCCUR in the pre-patch function and never be dereferenced there. That is exactly
  `detect_cycle`'s `tortoise.successor` (`tortoise = tortoise.successor`, never dereferenced), which still fires.
- `duplicates_block` asked only "is this added line, identifiers and literals abstracted, a line the function already
  has" — which is true of every in-place RENAME, because abstracting the identifiers is what makes a renamed line look
  like the line it replaced. `sympy__sympy-12489` is that patch and nothing else (`_af_new` → `cls._af_new`,
  `Perm` → `cls`, and a `coerse` → `coerce` typo in a docstring). "Duplicates" means the count went UP: `wrap`'s
  copied loop takes its normalised line from one occurrence to two, a rename removes one and adds one. `wrap` still
  fires.

**These three do NOT join `POOL_SUSPECT_SIGNALS`, and the fixes above stand on their own.** The bar is the one
docs/DECISIONS.md set on 2026-09-22 and iteration 3 applied to `late_guard`: a clean 198-gold sweep **AND** positive
evidence on the records — a replay in which the signal separates a recorded overfit from its gold. These three now
have the first half and not the second. A clean sweep says only "no gold carries this"; it does not say the signal
ever marks an overfit, and a signal that marks nothing cannot be the evidence that a pool holds no gold. (This
iteration first admitted them on the sweep alone. That was the ruling misapplied; the branch corrects it, and what
each still lacks is named in `guard.ts`: a replay record where it separates an overfit from a gold.)

`POOL_SUSPECT_SIGNALS` is therefore **`{mutates_new_argument}`** — iteration 3's set, unchanged.
`adds_special_case`, `deletes_statement` and `late_guard` stay out for the reasons iteration 3 recorded;
`guards_other_variable`, `dead_guard` and `duplicates_block` stay out pending a replay record; and
`guards_derived_local` joins them there, because the correction in item B took its two replay fires away.
**Iteration 4 adds no pool signal.**

**Which pools are gold-free under that set — the thing the next measurement must look at.** `detect_cycle`'s guard
pools are **not**. The three contenders that survive the structural rules (`dc_return`, `dc_return_alt`,
`dc_overfit`; the two `break` guards are refused as implicit-None exits) carry `dead_guard` and
`adds_special_case`, neither of which is swept, so `poolSuspect` is false, no Jev request is made, and
`probe_majority` commits a guard at L9 while the gold replaces L5. `guard.test.ts` asserts exactly that, per
contender, so the branch records the hole rather than claiming to have closed it. The hole
`20260922-013715-nlsygcax` showed is **still open**, and closing it needs a signal with positive record evidence,
which is what item B set out to find and did not.

The upside of ending here rather than at the five-signal set: the pool's 0.3 branch stays live. With five signals
`dead_guard` and `guards_derived_local` co-fired on every `detect_cycle` contender, making `strong.length >= 2` and
the bound 0.7 for essentially every guard pool — review finding 9 of iteration 3 reappearing under new names.

**D. Lone vs pool bound symmetry** — the asymmetry is real, and the records say to leave it. The lone branch takes
`signals.length >= STRONG_SIGNALS_MIN`, the pool branch takes
`pickSignals.filter(POOL_SUSPECT_SIGNALS.has).length >= STRONG_SIGNALS_MIN`; since `adds_special_case` rides on every
inserted guard, one more signal of any kind forces 0.7 on the lone path. Replayed over `bench/results/iter1-*` and the
`~/.jevcode/runs` records written before this iteration started (run ids `20260922-00…`–`20260922-18…`; 591 readable
records, 85 holding a lone-passer note, 142 lone-passer decisions):

| bound | signals on the lone passer | decisions |
|---|---|---|
| 0.3 | `adds_special_case` | 63 |
| 0.3 | `deletes_statement` + `adds_special_case` | 6 |
| 0.3 | `duplicates_block` | 3 |
| 0.3 | `duplicates_block` + `adds_special_case` | 2 |
| 0.3 | `dead_guard` + `adds_special_case` | 1 |
| 0.3 | `deletes_statement` | 1 |
| 0.3 | the note's signal list did not parse | 3 |
| **0.7** | `deletes_statement` + `adds_special_case` | **24** |
| **0.7** | `dead_guard` + `adds_special_case` | **1** |
| **0.7** | `deletes_statement` + `duplicates_block` + `adds_special_case` | **1** |
| **0.7** | `duplicates_block` + `adds_special_case` | **1** |
| **0.7** | `duplicates_block` + `guards_other_variable` + `dead_guard` + `adds_special_case` | **1** |
| n/a | the note carried no `general` (no request left, or a non-Noul answer) | 35 |

All 28 of the 0.7 rows were put there by signals that were UNSWEPT at `5ac0042`; 27 are holds, 1 committed straight
away with the reserve spent. Of the 27 holds:

| question | answer |
|---|---|
| any with `general < 0.3`, i.e. `unreleasable` — a hold `commitSuspect` will NOT release at step end? | **0 of 27** |
| the held site's file present in the run's final `model_patch.diff`? | **27 of 27** |
| the most frequent single case | ladder `units`, `composite/donor_body_unit:parse_size:3stmt` at `src/units.py:24`, general 0.50, in 13 runs |
| is that patch gold-equivalent? | **yes** — those runs finish with the `units` gold algorithm (`for unit in sorted(DURATION_UNITS, key=len, reverse=True): …`, the loop variable named `number`) |

So the 0.7 bound DELAYED a gold-equivalent lone passer to step end and marked it "possible overfit"; it never refused
one. Item D's condition for changing the lone path is not met, so **the lone path is left counting every signal**, and
`signal-sweeps.test.ts` pins that with the mechanism (0.50 → held → `commitSuspect` releases it as a possible
overfit; 0.12 → held → never released). `POOL_SUSPECT_SIGNALS` ends the iteration where it started, at one member,
so the POOL bound can never reach 0.7 at all — no pick can carry two swept signals — and the caveat the first
write-up raised is gone with the five-signal set that caused it.

Three caveats on the METHOD, from the review (defect 14), which reproduced the arithmetic independently (591
records, 104 parsed decisions with a `general` + 35 without + 3 unparsed = 142; 28 rows at bound 0.7 over 27
distinct runs; the 24/1/1/1/1 signal table; 0 of 28 below 0.3; 28 of 28 with the held file in the final patch):

- **20 of the 28 come from runs whose final patch touches exactly one file**, so for those the "held site's file is
  in the final patch" check can only come out positive. It is evidence that the run eventually edited the same
  file, not that the held candidate was committed, and not that the hold was free.
- the `units` case is **15** distinct runs, not 13, and **3** of the 28 rows are commit-with-reserve-spent notes
  rather than holds, not 1.
- "gold-equivalent" is defensible but "finishes with the `units` gold ALGORITHM" is the accurate phrasing: the gold
  is `text.strip().lower().replace(" ", "")` and the committed patch is `text.lower()`, which agrees only because
  `float()` tolerates surrounding whitespace. The dropped normalisation is a real difference.

None of the three touches the conclusion — the bound delayed and never refused — so the lone path is unchanged.

**Ring 1, by hand at the end.** The load gate was met when the arms started (`sysctl -n vm.loadavg` first value
**4.56**) and broke while they ran: another live bench took the machine to **79–118** within minutes, which is where
the Jev-ON reference arm goes noisy — iteration 3 recorded the same condition. Four arms of
`experiments/harness-next/quick.mts ring1` run by hand at `--concurrency 2` on the built bundle, offline, mock
provider, $0.

| task | Jev on | Jev off | verdict |
|---|---|---|---|
| `gcd` | pass, 2 steps / 32.2 s | pass, 2 steps / 60.2 s | **kept** (only slower, 1.87×) |
| `kth` | **fail**, `max_replans`/`replan_stop`, 11 steps / 332.5 s | **fail**, `replan_stop`, 20 steps / 841.8 s | **vacuous** — the reference arm did not solve it either on this machine |
| `mergesort` | fail, `replan_stop`, 10 steps / 269.9 s | **pass**, 14 steps / 988.2 s | **gained** (off solves what on does not) |
| `tagcloud` | pass, 2 steps / 7.5 s | pass, 2 steps / 8.3 s | **kept** (1.11×) |
| `units` | pass, 4 steps / 106.6 s | pass, 7 steps / 248.1 s | **kept** (only slower, 2.33×) |

The gate itself — "every task the Jev-on arm solves, the Jev-off arm solves" — is **met**: `gcd`, `tagcloud` and
`units` are all kept, and `mergesort` is a gain. The iteration-4 target, **`kth` passes off, is NOT met**, and the
record says why, which is the useful part:

- the `--jev off` `kth` run (`20260922-191528-ob2wgm5q`, `line Choice escaped` ×4, `grep -ic sbfl transcript.log` = 0
  — no coverage, so the code order alone chose the sites) **visits `kth.py:12:replace`**. Every previous `--jev off`
  `kth` run visited no replace site at all (`20260922-155658-35hfmbqm`) or only the first lines of the file. The
  item-A order reaches the gold line.
- it also **reaches WIDENED** (`widened · g1: 3 sites (1 gaps, 2 lines) over 1 function, by line evidence then
  distance from L10, cut 24`; the site list grows 12 → 20), which the recorded run never did — `widenedReachable` is
  what lets it.
- and it still fails: **7,377 candidates tested over 20 steps, and the string `k - num_lessoreq` never appears in
  the transcript or in `decisions.jsonl`.** `kth`'s gold replaces the argument `k` with the binary expression
  `k - num_lessoreq`, and no code source enumerates that at L12. So what remained of the `kth` loss after iteration 3
  was two problems stacked, and iteration 4 removed the localisation one: the rest is candidate generation, which is
  the next iteration's, not this one's.

The Ring-1 arms above ran before both fix passes and were **not re-run**. On the pool set, checked rather than
assumed: over the 30 Ring-1-era run records of those five tasks, 14 reach a >= 2-passer arbitration and **not one
logs `gold-free pool`** — `poolSuspect` never became true in any Ring-1 arm, so the size of
`POOL_SUSPECT_SIGNALS` did not enter a single Ring-1 decision and the table stands for every configuration this
branch passed through. On the SITE order it is the opposite, and the review says so (defects 3 and 4): the second
fix pass changed the statement-kind prior (`if` 1.28 → 0.80, `expr` 0.45 → 0.84), so the `kth` six moved from
`10, 12, 14, 9, 2, 3` to `10, 12, 14, 2, 3, 4`, and `widenedReachable` now reads the Q5n ranking. **The Ring-1
table is stale on those arms and a re-run is owed** — the one thing it establishes that survives is that the gold
line L12 is reached and WIDENED is entered, both of which the new order also does (L12 is still second).

**Tests, labelled by what they establish** (a test that fails on `5ac0042` only because a symbol did not exist is not
a failing-first record):

*Failing-first by mechanism* — `signal-sweeps.test.ts`'s **14 correct shapes**, every one of which fired at some
point in this branch's history and must not now (the six the second review measured at `b3c28a0`: `items.sort()`,
`s.lower()`, `cfg.get()`, `rows.append()`, the `if/else` branch and the `try/except`; and the eight the first
review measured at `822be5b`: `log(result)`, `len(ys)`, `isinstance`, the `for` loop, `visited.add`, the rebind,
the comprehension and the nested `def`); `code-order.test.ts` "the six replace sites hold L12 …" (on `5ac0042`:
`[2, 3, 4, 6, 7, 9]`), "a continuation physical line is ranked LAST" (`3,4,2` at `b3c28a0`), "the failure
vocabulary is bounded", "round-robin across functions", "is total and stable …", the `widenedReachable` cases and
the two `defect 4` Q5n cases, and `defect 5`'s one-line short-circuit (null at `b3c28a0`); `signal-sweeps.test.ts`
"the recorded 0.50 is HELD, not refused".

*Regression pin* — `code-order.test.ts` "an SBFL ranking still leads, and the code order takes only the tail";
`sites.test.ts`'s `[9, 7, 15, 8, 2, 4]` and `[9, 8, 15, 2, 4]` orders and its mixed-localisation case, unchanged;
`late-guard.test.ts`'s 16 correct shapes and the `sympy__sympy-17139` gold; `guard.test.ts`'s `wrap` and
`detect_cycle` signal lists, which are the iteration-3 four again; the whole of `test/unit/loop` and
`test/unit/bench`.

*Regression pin, labelled as a deliberate behaviour change* — `code-order.test.ts`'s Jev-ON mixed finite/infinite
case (`9, 8, 3, 6, 5, 2`): the branch re-orders the tail sites the spectrum did not rank, in every run, and this
pin is what measures that instead of denying it.

*Assertion that a hole is OPEN* — `guard.test.ts`'s two class A′ cases: `detect_cycle`'s pools are committed by
`probe_majority` with no Jev request, per contender no swept signal, which is the `20260922-013715-nlsygcax` hole
unclosed.

*Fixture property* — `signal-sweeps.test.ts`'s three per-corpus sweeps, its "every patch is analysable, 0 skipped"
and its `guards_derived_local` POWER (6 of 198); `code-order.test.ts`'s re-derivation of
`GOLD_STATEMENT_KIND_PRIOR` from `bench/data`, now by rank order and tolerance so the corpus can grow.

**Recorded, not fixed** (review defects 9–12, 14; each is lone-passer-only or a bounded cost, and each is
written at the code that carries it):

- **defect 9** — narrowing `dead_guard` to "the subject OCCURS in the pre-patch function" also blinds it to a guard
  on a name the PATCH introduces and never uses, which is a textbook dead guard. One Q16 question, lone-passer-only.
- **defect 10** — `duplicates_block`'s growth rule lets a MOVED block escape (insert two lines the function has and
  delete the originals: growth 0; `deletes_statement` catches it instead), and the count is file-wide, so a
  duplication in one function can cancel a deletion in another.
- **defect 11 — FIXED**, it was a one-liner: the identifier loop over the failure text had no cap while
  `testLiterals` has 40 and `taskIdentifiers` 60. Capped at 60, and `File "…", line N, in …` frame furniture is
  dropped (one five-frame traceback used to yield 55 entries, mostly path components).
- **defect 12** — the round-robin caps the failing call's own function at one of the six when there are ≥ 6 groups
  in the tail. Accepted: it is the price of the fairness rule, still far better than file order, and a
  single-function localisation degenerates correctly.
- **defect 14** — item D's method caveats, recorded above with the corrected counts (15 `units` runs, 3
  reserve-spent, 20 of 28 single-file patches).

Files: `src/synth/py/{structure,index}.ts`, `src/synth/search/{sites,subgoal,guard}.ts`. No flag. `testLiterals` and
`taskIdentifiers` moved from `subgoal.ts` to `sites.ts` (which `subgoal.ts` re-exports, so no caller changed) because
the code-side order reads them and the other direction would be an import cycle. `test/unit/synth/search/gold-corpus.helpers.ts`
lifts iteration 3's sweep harness out of `late-guard.test.ts`, unchanged, so every sweep in the repository reads the
same 198 patches.

Gates on this tree: `tsc --noEmit` clean; `scripts/no-any.mjs` ok (src, test, perf, scripts); `scripts/jev-contract.mjs`
ok (32 Jev call sites, 2 four-clause blocks, 30 allow-listed); `vitest --project unit --maxWorkers=2 test/unit/synth
test/unit/jev test/unit/loop test/unit/bench` → **205 files / 2,798 passed**.
