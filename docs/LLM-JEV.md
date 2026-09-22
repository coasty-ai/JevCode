# LLM-JEV — measurement log

The running log of the `llm-jev` mode (docs/LLM-JEV-DESIGN.md: the full engine with the Synthesizer, the generating LLM as a
candidate source inside it, Jev localising and arbitrating, shadow lanes verifying; bench arm `--conditions llm-jev`). One dated
entry per measurement, with the numbers, the run ids and the report they come from; the design doc holds the plan and the
criterion, `experiments/results/` holds the reports. Live results only — nothing here is projected.

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
`751e3bf` with `JEVCODE_WARM=off` **6 steps / 2,180 tested in 80.8 s**. `warmModeFor` defaults the plane on for every
`quixbugs` and `pytest` runner. Everything below therefore ran with `JEVCODE_WARM=off`; fix the plane before the next arm.

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

## 2026-09-22 — iteration 3 (implemented, unmeasured)

Branch `oos-iter-3` from `d86c385`. The four items OOS iteration 2 analysed with evidence and did not land. **Nothing
here is measured**: this entry records what changed and on what evidence, and every number in it comes from the
iteration-1 records replayed offline (`bench/results/iter1-*/runs/<runId>/{decisions,steps,jev}.jsonl.gz`,
`~/.jevcode/runs/20260922-013715-nlsygcax`) or from a code sweep of `bench/data`, never from a run of this build.
`experiments/results/` gets its numbers when the next slice is taken.

**1. `late_guard` — a thresholdless overfit signal for a guard the patch puts too late.**
`src/synth/py/structure.ts` `guardClauses` / `isLateGuard` (+ `guardPlacement`), differenced by
`src/synth/search/guard.ts` `newlyLateGuards`, surfaced as the seventh `SuspicionSignal`. A guard CLAUSE (an `if` with
no `elif`/`else` whose body leaves the suite) is late when it is not the first statement of its block and either a
statement in front of it already READS one of its operands, or — for a guard the patch INSERTED — nothing in front of
it binds one, so it could have stood at the top unchanged. Evidence: the two iteration-1 correctness losses whose own
golds are the same guard AT THE TOP of the block — `stats` (`20260922-123643-rcnailmj`, `if not ordered: raise …`
inserted behind `mid = len(ordered) // 2`; the gold inserts `if not values: raise …` as the first statement of
`median`) and `token_bucket` (`20260922-115943-acykmmph`, `cost > self.capacity` added as a disjunct behind
`if self.tokens >= cost: return 0.0`; the gold inserts `if cost > self.capacity: return None` at the top of
`wait_for`). It is a SIGNAL, arbitrated by Q15/Q16 — never a rejection: a sole passer whose only fault is a late guard
is asked about and committed when Jev keeps it. **Gold sweep: 0 of 41 QuixBugs gold patches and 0 of 65 ladder gold
files (26 tasks, the long-2 six included) add a late guard, and no gold is refused by any structural rule**
(`test/unit/synth/search/late-guard.test.ts`). Replayed over the patches iteration 1 actually COMMITTED — the 46 of 64
archived `model_patch.diff.gz` that are non-empty and apply to the pristine bench source — it fires **3 times**, and
the three are `token_bucket`, `stats` and `detect_cycle`: the whole of that measurement's correctness losses and
nothing else. (It fired a fourth time before `isDeclaration` landed, on `hunk_merge`'s local `within()` helper; a
nested `def` runs nothing where it stands, so it is not a position a guard can be behind.)

**2. Why `detect_cycle` was outvoted — and it was not the `SUSPECT_NOUL_MAX` threshold.** Replaying
`20260922-013715-nlsygcax` shows the guard DID hold the passer the analysis' Q6 row names: `general_cand_01` 0.44 with
four signals was the lone-passer advisory and it held (0.44 < 0.7). The hole is the next line of the transcript — a
fifth passer arrived, and on the ≥ 2 path `decide` never computed `suspicionSignals` at all, so the four signals were
discarded and `fewestSpecialCases` committed a DIFFERENT guard insert ("+1c/+0l") by code with no Jev request. Every
passer of that batch inserted a guard at L9/L10 while the gold REPLACES L4: a gold-free pool the code ranking rules
cannot see. Two changes, no threshold touched: (a) the Q16 `true` example "a missing guard added exactly where the
failing input reaches" — which reads as satisfied by a patch that is literally a missing guard being added — now says
"in front of the code that uses the value, naming the variable the failure names", and the `false` side gains the two
missing counter-examples (a guard behind the statements that already use the value; a guard naming a different
variable than the failure dereferences), both sides keeping ≥ 2 examples per REPORT.md; (b) `decide` computes the
signals for every contender, puts them in the Q15/Q16 state (`signals`, `signals_note`), and when EVERY contender
carries a SHAPE signal (`POOL_SUSPECT_SIGNALS` — every signal but `adds_special_case`, which fires on golds too and is
already the input of `fewestSpecialCases`) the three code RANKING rules are skipped and the arbitration's pick must
clear the bound its own signal count already implies for a lone passer (`LONE_PASSER_VOUCH_MIN_NOUL` at two or more).
`preferLlmInCluster` is untouched — an LLM candidate behaving exactly like a code seed is an independent witness, not
a ranking. Replayed on the records this refuses `stats` (pick at the recorded general **0.49** < 0.7) and
`token_bucket` (**0.39** < 0.7); it is the one change here that can COST a pass, since both tasks passed in
iteration 1 with those very patches.

**3. `JEVCODE_DEADLINE_GROWTH=served|always`, default `always`** (`src/synth/llm/source.ts`
`deadlineGrowthFrom` / `LlmSourceDeps.deadlineGrowth`, threaded through `SearchLlmOptions.deadlineGrowth`). Iteration 2's
counter-hypothesis as an A/B arm: 61 of the fresh slice's 135 zero-token timeouts fired at an already-grown deadline
and cost 1,994 s, while only 11 samples were ever SERVED past 20 s. Under `served` a zero-token timeout books neither a
growth nor a floor, and the only thing that raises a goal's high-water mark is a sample the provider actually served at
a latency past it (capped at the class ceiling). The streak and the round pause are identical in both arms, so an A/B
moves the deadline and nothing else. `always` is byte-identical to what iteration 2 shipped. The arm is RECORDED, not
logged: `LlmTrace.deadlineGrowth` → `StepRecord.verify.deadlineGrowth` (steps.jsonl) → `StepsSummary.deadlineGrowth`
(`tasks.jsonl` `synth`, unioned to `mixed` across arms).

**4. Ring 1's residual: the escaped code order was cut at a RANKING's width.** Iteration 2 made an all-escape line
Choice produce sites; it cut them at `anchorsPerFunction` = 3, a bound measured on a Jev top-3 ("top-3 covers 36/40").
With no Jev opinion, no traceback frame and no coverage the "code order" is the file's own line order, so a top-3 of it
is the first three lines of the function. The recorded `--jev off` `kth` run visited nine sites and **every one was an
insert gap** (`kth.py:2 (gap), kth.py:10 (gap), kth.py:12 (gap), …`) — no replace site anywhere in the run, `plausible
0` on every step, `replan_stop` at 11 — while the gold REPLACES L12. `mergesort`'s gold replaces L17 (the first
statement after the nested `merge` def). New option `escapedAnchors` (40) is used on the escaped branch only, so a
Jev-on trajectory is unchanged (pinned by a test that a ranked line Choice still gets its three-anchor beam and a
strictly shorter site list) and the site list stays bounded (`units` 2 files / 57 lines → 70 sites, `crossfile` 5 /
156 → 47, `six_hunks` 6 / 148 → 20).

**4b. And a second Ring-1 hole, which is what `units` actually was.** The anchor width does not explain `units` — its
gold lines 24–26 are anchored either way. Run `20260922-155631-5dprh2ue` (`--jev off`, ladder `units`) parks every
goal with `no site located for …` and `sites 0, requests 6, runs 0`: with Jev off the file Nouls are inert, the file
and confirm stages spend the whole localise budget, and both code fallbacks that cost NO request —
`codeDerivedFunctions` in the pipeline and `codeDerivedLines` in `stageLines` — were gated behind `asker.canAsk()` /
`affordable(0)`, i.e. behind the very budget whose exhaustion is what they exist for. Both gates are gone: the
affordable prefix of the function beam is ASKED about and the rest is answered in code, and an anchor with no Jev
evidence is ordered after every anchor that has some, so a starved beam can never outrank a Choice.

Files: `src/synth/py/{structure,index}.ts`, `src/synth/search/{guard,llm,subgoal,index,types}.ts`,
`src/synth/llm/source.ts`, `src/synth/localize/{index,types}.ts`, `src/bench/{step-records,types}.ts`,
`src/core/types.ts`. Tests: `test/unit/synth/search/{late-guard,gold-free-pool}.test.ts`,
`test/unit/synth/llm/deadline-growth.test.ts`, `test/unit/synth/localize/jev-off-fallback.test.ts`,
`test/unit/bench/records.test.ts`. Flag names: **`JEVCODE_DEADLINE_GROWTH`** (`served` | `always`, default `always`).
