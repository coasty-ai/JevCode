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
5. then **round-robin across function groups**, so one function cannot take all six.

SBFL is unchanged and still leads: the tail is split into the rows the spectrum ranked (sorted by rank, exactly as
before) and the rows it said nothing about (this order). The only comparison this changes is the one that was NaN, so
a Jev-ON trajectory with a real ranking is byte-identical — `sites.test.ts`'s `[9, 7, 15, 8, 2, 4]` and
`[9, 8, 15, 2, 4]` pins and the `test/fixtures/loop/*golden*` fixtures are untouched, and the iteration-3
starved-beam pin in `review.test.ts` did not move (it did not need re-pinning).

**The statement-kind prior, measured.** Over all 198 gold patches in `bench/data` (QuixBugs 41, ladder 65 files,
`swebench-verified-30.gold.json` 92 Python hunks), every BEFORE-image line the gold removes or rewrites, classified by
`statementAt(...).kind` at the statement's first line (a later physical line of a multi-line statement is
`continuation`), against the background of every line of those images that could be a replace site at all (non-blank,
non-comment, not a `def`/`class` header). 155 of the 198 images parse — 43 SWE-bench hunk fragments do not tokenize
even after dedenting and are in neither numerator nor denominator. 161 gold lines against 2,171 background lines, so
the base rate is r0 = 161/2171 = 0.0742. The one smoothing is fixed by the measurement rather than picked: one pseudo
gold line on top and, on the bottom, the 1/r0 = 13.48 background lines one gold line is worth at the base rate, so
`prior(k) = ((gold_k + 1) / (bg_k + 1/r0)) / r0` and a kind the corpus never showed lands on exactly 1.00.

| statement kind | gold lines | background lines | raw rate | smoothed rate | **prior** |
|---|---|---|---|---|---|
| `while` | 3 | 15 | 20.0 % | 14.0 % | **1.89** |
| `continuation` | 20 | 152 | 13.2 % | 12.7 % | **1.71** |
| `return` | 56 | 445 | 12.6 % | 12.4 % | **1.68** |
| `break` | 1 | 5 | 20.0 % | 10.8 % | **1.46** |
| `if` | 19 | 197 | 9.6 % | 9.5 % | **1.28** |
| `assign` | 38 | 446 | 8.5 % | 8.5 % | **1.14** |
| `augassign` | 2 | 29 | 6.9 % | 7.1 % | **0.95** |
| `for` | 6 | 86 | 7.0 % | 7.0 % | **0.95** |
| `assert` | 0 | 1 | 0.0 % | 6.9 % | **0.93** |
| `continue` | 0 | 4 | 0.0 % | 5.7 % | **0.77** |
| `try` | 0 | 5 | 0.0 % | 5.4 % | **0.73** |
| `except` | 0 | 6 | 0.0 % | 5.1 % | **0.69** |
| `import` | 0 | 9 | 0.0 % | 4.4 % | **0.60** |
| `elif` | 0 | 10 | 0.0 % | 4.3 % | **0.57** |
| `expr` | 13 | 403 | 3.2 % | 3.4 % | **0.45** |
| `other` | 2 | 82 | 2.4 % | 3.1 % | **0.42** |
| `else` | 0 | 23 | 0.0 % | 2.7 % | **0.37** |
| `raise` | 0 | 50 | 0.0 % | 1.6 % | **0.21** |
| `from_import` | 1 | 203 | 0.5 % | 0.9 % | **0.12** |

Per corpus, the gold lines behind it: QuixBugs 37 (`return` 10, `if` 7, `assign` 7, `while` 3, `for` 3,
`continuation` 3, `expr` 2, `augassign` 1, `other` 1); ladder 67 (`return` 35, `assign` 17, `if` 8, `expr` 4, `for` 1,
`augassign` 1, `continuation` 1); SWE-bench Verified 57 (`continuation` 16, `assign` 14, `return` 11, `expr` 7,
`if` 4, `for` 2, `other` 1, `from_import` 1, `break` 1). `while` and `break` are 3- and 1-sample cells; the smoothing
is what keeps them from dominating, and the whole table is re-derived from `bench/data` by
`test/unit/synth/search/code-order.test.ts`, which fails if the corpus moves.

**`kth` under `--jev off`**, through the real localiser and `buildGoalSites` on the recorded run's own task text and
failure: the six replace sites are now **`L10, L12, L14, L9, L2, L3`** — the two lines naming `kth` (the task's own
backticked identifier) first, then the remaining `return`, then the `if`, then the assignments in line order. On
`5ac0042` the same inputs give `[2, 3, 4, 10, 12, 14]` with the inert-0.5 Q5n in front, and `[2, 3, 4, 6, 7, 9]` once
that is removed. The gold L12 is reached second.

**WIDENED.** `sites.every(seedsExhaustedAt)` is the right gate for a site budget a Jev RANKING chose. With no ranking
the six are a code ORDER and `REPLACE_SITES_MAX` is a cut justified by "a Jev top-3 covers 36/40", so running it out
exhausts the order, not the space. `widenedReachable` adds: with no `jevProbability` anywhere in the list, every
REPLACE site being seed-exhausted is enough, gaps or no gaps. The recorded `kth` run parks in phase `LLM` with its
gaps still open and never reaches WIDENED.

**B. `guards_derived_local` — the data-flow signal** (`src/synth/py/structure.ts` `parameterDerivedLocals` /
`guardsDerivedLocal`, differenced by `src/synth/search/guard.ts` `newlyDerivedLocalGuards`).

The iteration-3 author's disagreement 1, as code. A function's contract is about its PARAMETERS, so a guard on a
parameter is a precondition and belongs at the top; a guard on a value the function computed for itself, inserted
behind the first statement that used that value, is a patch for the one path the tests took. Precisely: for at least
one operand path of a guard clause the patch ADDS, with root R — R is a `parameterDerivedLocals` name of the
enclosing `def` (bound, to a fixed point, from an expression that reads a parameter, and not a parameter itself), a
statement of the block strictly before the clause BINDS R, and a statement of the block strictly before the clause
READS R (`readsName`, so a binder's own target is not a read of itself). An inserted clause is judged on all of its
operands, a condition rewrite only on the operands the edit added — the same INSERTED/EDITED split
`newlyLateGuards` uses.

Only the first half of the item's definition is implemented. The second ("whose operand is not on the path from any
parameter to the failing expression") is already `guards_other_variable` — "the added guard names no root the failing
traceback dereferences" — and item C sweeps that one clean, so it carries that half into the pool itself rather than
being duplicated inside this signal.

| corpus | patches | `guards_derived_local` fires | not analysable |
|---|---|---|---|
| QuixBugs golds | 41 | **0** | 0 |
| ladder golds | 65 files, 26 tasks | **0** | 0 |
| SWE-bench Verified golds (92 Python hunks / 30 instances) | 92 | **0** | 30 hunk fragments that do not tokenize |
| **total** | **198** | **0** | 30 |

The iteration-1 replay, which is the half `late_guard` failed:

| record | patch | fires? | why |
|---|---|---|---|
| ladder `stats` | `if not ordered: raise …` inserted before `return (ordered[mid-1] + …)` | **YES** (`median:not ordered`) | `ordered = sorted(values)` is derived from the parameter, and `mid = len(ordered) // 2` read it first |
| QuixBugs `detect_cycle` (`20260922-013715-nlsygcax`) | `if not hare.successor.successor: break` inserted before `hare = hare.successor.successor` | **YES** (`detect_cycle:not hare.successor.successor`) | `hare = tortoise = node` is derived, and `if hare.successor is None:` read it first |
| ladder `token_bucket` | `if self.refill_per_second <= 0.0:` → `if cost > self.capacity or …` | **no** | the overfit and the GOLD guard the same two values, `cost` and `self.capacity`, and both are parameters of `wait_for`; what separates them there is placement, not data flow |

Both golds beside them are silent, and the `detect_cycle` gold is the check that the placement half is load-bearing:
it adds `hare` — a derived local — to the clause at the TOP of the `while` body, where nothing in front has read
`hare` yet. 0 fires on 198 golds **and** 2 of 3 on the records, so it clears both halves of the bar ruling 1 set and
joins `POOL_SUSPECT_SIGNALS`. It is the first signal admitted with positive evidence as well as a clean sweep.

**C. The three unswept signals** (`duplicates_block`, `guards_other_variable`, `dead_guard`). These were in
`SuspicionSignal` from the start and no sweep had ever been run on them. It found four gold fires, each a concrete
false positive:

| signal | QuixBugs 41 | ladder 65 | SWE 92 (30 unparsed) | as it stood | after the fix |
|---|---|---|---|---|---|
| `guards_other_variable` | 0 | 0 | 0 | clean | clean → joins the pool set |
| `dead_guard` | 1 — `topological_ordering.py` | 0 | 2 — `sympy__sympy-17139`, `pytest-dev__pytest-10081` | 3 fires | **0** → joins |
| `duplicates_block` | 0 | 0 | 1 — `sympy__sympy-12489` | 1 fire | **0** → joins |

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

`POOL_SUSPECT_SIGNALS` is therefore `{mutates_new_argument, guards_other_variable, dead_guard, duplicates_block,
guards_derived_local}`. `adds_special_case`, `deletes_statement` and `late_guard` stay out for the reasons iteration 3
recorded. **The consequence, stated plainly: `detect_cycle`'s guard pools are now gold-free pools.** The two class A′
tests that used to commit `dc_return` / `a1` by `probe_majority` with no Jev request now arbitrate them and commit the
same candidate at general 0.70 ≥ the 0.7 vouch bound; with no Jev request left the code rules still decide, unchanged,
and both of those are re-pinned with the reason. That is the hole `20260922-013715-nlsygcax` showed and the reason
item B exists — and it is also the largest behaviour change in this branch and the one a measurement should look at
first.

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
overfit; 0.12 → held → never released). The honest caveat: `POOL_SUSPECT_SIGNALS` has just grown from one member to
five, so the POOL bound will now reach 0.7 far more often than it did when this replay was recorded, and the replay
says nothing about that.

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

**Tests, labelled by what they establish** (a test that fails on `5ac0042` only because a symbol did not exist is not
a failing-first record):

*Failing-first by mechanism* — `code-order.test.ts` "the six replace sites hold L12 …" (on `5ac0042`:
`[2, 3, 4, 10, 12, 14]`, driven by the inert-0.5 Q5n), "round-robin across functions: one function cannot take all
six", "is total and stable …", and the three `widenedReachable` cases; `signal-sweeps.test.ts` "`stats` FIRES",
"`detect_cycle` FIRES", "`token_bucket` does NOT fire" and "the recorded 0.50 is HELD, not refused";
`guard.test.ts`'s two class A′ cases, which were `probe_majority` / `requests: 0` on `5ac0042` and are arbitrated
now.

*Regression pin* — `code-order.test.ts` "an SBFL ranking still leads, and the code order takes only the tail";
`sites.test.ts`'s `[9, 7, 15, 8, 2, 4]` and `[9, 8, 15, 2, 4]` orders and its mixed-localisation case, unchanged;
`late-guard.test.ts`'s 16 correct shapes and the `sympy__sympy-17139` gold; `guard.test.ts`'s `wrap` and
`detect_cycle` signal lists (the latter gains `guards_derived_local` and is re-pinned); the whole of
`test/unit/loop` and `test/unit/bench`.

*Fixture property* — `signal-sweeps.test.ts`'s four per-corpus sweeps and its 198-patch count; `code-order.test.ts`'s
re-derivation of `GOLD_STATEMENT_KIND_PRIOR` from `bench/data`.

Files: `src/synth/py/{structure,index}.ts`, `src/synth/search/{sites,subgoal,guard}.ts`. No flag. `testLiterals` and
`taskIdentifiers` moved from `subgoal.ts` to `sites.ts` (which `subgoal.ts` re-exports, so no caller changed) because
the code-side order reads them and the other direction would be an import cycle. `test/unit/synth/search/gold-corpus.helpers.ts`
lifts iteration 3's sweep harness out of `late-guard.test.ts`, unchanged, so every sweep in the repository reads the
same 198 patches.

Gates on this tree: `tsc --noEmit` clean; `scripts/no-any.mjs` ok (src, test, perf, scripts); `scripts/jev-contract.mjs`
ok (32 Jev call sites, 2 four-clause blocks, 30 allow-listed); `vitest --project unit --maxWorkers=2 test/unit/synth
test/unit/jev test/unit/loop test/unit/bench` → **205 files / 2,772 passed**.
