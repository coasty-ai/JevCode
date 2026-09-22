# llm-jev iteration 1 — script outputs (2026-09-22)

Companion to `experiments/results/llm-jev-iter1.md`. Everything below is verbatim tool output, filtered only for secrets (`grep -vE 'sk-|api[_-]?key'`; nothing matched).

## 0. The warm-plane A/B (offline, $0, one task, `--concurrency 1`, same machine)

```
bench --suite quixbugs --task-id mergesort --conditions llm-jev --concurrency 1 --max-steps 6 --max-wall 3m   (no --live)

build / runner                                       stopReason       wall   steps     tested
066816f  tsx src/cli/main.tsx                        max_steps     107.4 s       6       2896
168a599  tsx (iter-1, before the ten review fixes)   wall_time     180.1 s       0          0
751e3bf  tsx src/cli/main.tsx                        wall_time     180.1 s       0          0
751e3bf  bin/jevcode.js (built bundle)               wall_time     180.1 s       0          0
751e3bf  bin/jevcode.js JEVCODE_WARM=off             max_steps      80.8 s       6       2180
```

The wedged step-1 transcript line, verbatim:

```
[step 1] synth verify: g1: 0 tested on 8 lanes (nothing ran); runs left 1488, test wall left 0 s; warm 4/8, screen 540 ms, 4 fallbacks, 4 restarts; aborted; lane failure: LaneError: `git checkout -- . && git clean -fdq` failed (exit null, killed: wall_time):  (candidates=8, tested=0)
[run] end wall_time steps=0 wall=3m cost=$0.000 (gen $0.000, jev $0.000) exit 4
```

## 1. Fresh slice head-to-head — `experiments/llm-jev/headtohead.mts`

# llm-jev head-to-head — llm-jev vs jev-off-tuned

Sources: `iter1-fresh-jev-off-tuned-quixbugs`, `iter1-fresh-jev-off-tuned-ladder-long2`, `iter1-fresh-jev-off-tuned-swebench`, `iter1-fresh-llm-jev-quixbugs`, `iter1-fresh-llm-jev-ladder-long2`, `iter1-fresh-llm-jev-swebench`. Arms present: llm-jev, jev-off-tuned. Verdict files for: jev-off-tuned, llm-jev. Records: 36.

## Verdict (§10.6)

Failed: quixbugs criterion 1 (pass (discordant pairs)); quixbugs criterion 2 (correct-by-verdict); quixbugs criterion 3 (wall (median per task)); ladder criterion 3 (wall (median per task)); swebench criterion 1 (pass (discordant pairs)). Not evaluable: ladder criterion 4, swebench criterion 3, swebench criterion 4.

### Attribution (criterion 5, secondary)

- criterion 5a — attribution vs llm-sieve: not evaluable (not gating) — no paired llm-sieve records
- criterion 5b — attribution vs jev-off-tuned: reported (not gating) — quixbugs: pass 8 vs 8 of 8, correct 8 vs 8, median wall 1.33×, $ per solved 0.20×; ladder: pass 4 vs 0 of 6, correct 3 vs 0, median wall 2.57×, $ per solved n/a; swebench: pass 0 vs 1 of 3, correct 0 vs 1, median wall 0.29×, $ per solved n/a

## QuixBugs Python (40 one-line bugs)

Limits (summary.json): 12 steps / 8 min / $0.06 per task.

#### Arms (all evaluated records of the suite)

| arm | pass | Wilson 95% | correct | overfit | steps-to-solve median | wall median / mean | $ per task | $ per solved | generator calls / valid / length / dropped | est. $ | Jev requests (stubbed) | refused | patchEmpty | drift |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| llm-jev | 8/8 100% | [68%, 100%] | 8 | 0 | 3 (n=8) | 24s / 30s | $0.0006 | $0.0006 | 12 / 7 / 0 / 5 | $0.0008 | 33 | 0 | 0 | 0 |
| jev-off-tuned | 8/8 100% | [68%, 100%] | 8 | 0 | 7 (n=8) | 18s / 25s | $0.0030 | $0.0030 | 61 / 58 / 0 / 3 | $0.0011 | 0 | 0 | 0 | 0 |

#### Paired vs baseline (tasks evaluated in both, drift excluded)

| arm vs baseline | n | b (arm wins) | c (baseline wins) | both | neither | sign test p | median wall | Wilcoxon p | $ per task | $ per solved | correct |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| llm-jev vs jev-off-tuned | 8 | 0 | 0 | 8 | 0 | n/a | 24s vs 18s (1.33×) | 0.680 | 0.20× | 0.20× | 8 vs 8 |

#### Pre-registered criteria (§1.3)

- criterion 1 — pass (discordant pairs): **FAIL** — n = 8: b = 0 (llm-jev wins), c = 0 (jev-off-tuned wins), both 8, neither 0; bar b − c ≥ 8 ∧ c ≤ 2; sign test p n/a
- criterion 2 — correct-by-verdict: **FAIL** — llm-jev 8 vs jev-off-tuned 8 correct of 8 (Δ +0, bar ≥ +8)
- criterion 3 — wall (median per task): **FAIL** — median 24s vs 18s (1.33×, bar ≤ 0.5×); one-sided Wilcoxon signed-rank p = 0.680 over 8 non-tied pairs (bar < 0.05)
- criterion 4 — cost ($ per solved, $ per task): **pass** — $ per solved $0.0006 vs $0.0030 (0.20×, bar ≤ 0.75×); $ per task $0.0006 vs $0.0030 (0.20×, bar ≤ 1×)
- criterion S1 — refused steps (blocked + declined) on the candidate: **pass** — 0 (bar 0)
- criterion S2 — patchEmpty ≤ baseline: **pass** — 0 vs 0
- criterion S3 — zero modelDrift on the candidate: **pass** — 0 record(s) with drift (excluded from the pairs)

#### Per task

| task | llm-jev | steps | wall | $ | jev-off-tuned | steps | wall | $ |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| quicksort | pass | 3 | 53s | $0.0009 | pass | 10 | 18s | $0.0041 |
| rpn_eval | pass | 2 | 22s | $0.0007 | pass | 6 | 16s | $0.0022 |
| shortest_path_lengths | pass | 2 | 24s | $0.0006 | pass | 8 | 51s | $0.0030 |
| shortest_paths | pass | 3 | 31s | $0.0005 | pass | 7 | 20s | $0.0026 |
| sieve | pass | 3 | 23s | $0.0004 | pass | 6 | 10s | $0.0023 |
| subsequences | pass | 3 | 22s | $0.0004 | pass | 12 | 36s | $0.0057 |
| to_base | pass | 3 | 27s | $0.0004 | pass | 8 | 45s | $0.0027 |
| topological_ordering | pass | 2 | 35s | $0.0009 | pass | 4 | 6s | $0.0014 |

## Ladder (hand-made multi-hunk tasks)

Limits (summary.json): 30 steps / 15 min / $0.18 per task.

#### Arms (all evaluated records of the suite)

| arm | pass | Wilson 95% | correct | overfit | steps-to-solve median | wall median / mean | $ per task | $ per solved | generator calls / valid / length / dropped | est. $ | Jev requests (stubbed) | refused | patchEmpty | drift |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| llm-jev | 4/6 67% | [30%, 90%] | 3 | 1 | 9 (n=4) | 5m28s / 7m34s | $0.0332 | $0.0499 | 250 / 73 / 0 / 177 | $0.0514 | 927 | 0 | 0 | 0 |
| jev-off-tuned | 0/6 0% | [0%, 39%] | 0 | 0 | n/a | 2m7s / 2m19s | $0.0185 | n/a | 182 / 171 / 0 / 9 | $0.0054 | 0 | 0 | 4 | 0 |

#### Paired vs baseline (tasks evaluated in both, drift excluded)

| arm vs baseline | n | b (arm wins) | c (baseline wins) | both | neither | sign test p | median wall | Wilcoxon p | $ per task | $ per solved | correct |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| llm-jev vs jev-off-tuned | 6 | 4 | 0 | 0 | 2 | 0.063 | 5m28s vs 2m7s (2.57×) | 0.984 | 1.79× | n/a | 3 vs 0 |

#### Pre-registered criteria (§1.3)

- criterion 1 — pass (discordant pairs): **pass** — n = 6: b = 4 (llm-jev wins), c = 0 (jev-off-tuned wins), both 0, neither 2; bar b − c ≥ 3 ∧ c ≤ 1; no p-value (under-powered by design)
- criterion 2 — correct-by-verdict: **pass** — llm-jev 3 vs jev-off-tuned 0 correct of 6 (Δ +3, bar ≥ +2); overfits 1 (bar ≤ 1)
- criterion 3 — wall (median per task): **FAIL** — median 5m28s vs 2m7s (2.57×, bar ≤ 0.5×); one-sided Wilcoxon signed-rank p = 0.984 over 6 non-tied pairs (bar < 0.05)
- criterion 4 — cost ($ per solved, $ per task): not evaluable — $ per solved $0.0499 vs n/a (n/a, bar ≤ 0.9×); $ per task $0.0332 vs $0.0185 (1.79×, bar ≤ 1×)
- criterion S1 — refused steps (blocked + declined) on the candidate: **pass** — 0 (bar 0)
- criterion S2 — patchEmpty ≤ baseline: **pass** — 0 vs 4
- criterion S3 — zero modelDrift on the candidate: **pass** — 0 record(s) with drift (excluded from the pairs)

#### Per task

| task | llm-jev | steps | wall | $ | jev-off-tuned | steps | wall | $ |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| csv_schema | fail | 24 | 14m29s | $0.0499 | fail | 30 | 2m4s | $0.0195 |
| deadline_queue | pass | 9 | 4m45s | $0.0118 | fail | 30 | 2m53s | $0.0190 |
| dep_order | pass | 12 | 8m20s | $0.0376 | fail | 30 | 2m7s | $0.0185 |
| hunk_merge | pass | 13 | 5m28s | $0.0317 | fail | 30 | 2m25s | $0.0176 |
| route_match | fail | 21 | 10m57s | $0.0627 | fail | 30 | 1m24s | $0.0184 |
| token_bucket | pass | 3 | 1m29s | $0.0057 | fail | 30 | 3m | $0.0181 |

## SWE-bench Verified (local subset)

Limits (summary.json): 25 steps / 25 min / $0.25 per task.

#### Arms (all evaluated records of the suite)

| arm | pass | Wilson 95% | correct | overfit | steps-to-solve median | wall median / mean | $ per task | $ per solved | generator calls / valid / length / dropped | est. $ | Jev requests (stubbed) | refused | patchEmpty | drift |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| llm-jev | 0/4 0% | [0%, 49%] | 0 | 0 | n/a | 1m1s / 1m11s | $0.0118 | n/a | 28 / 0 / 0 / 28 | $0.0091 | 126 | 0 | 0 | 0 |
| jev-off-tuned | 1/3 33% | [6%, 79%] | 1 | 0 | 12 (n=1) | 1m56s / 2m46s | $0.0270 | $0.1082 | 91 / 81 / 0 / 6 | $0.0074 | 0 | 0 | 1 | 0 |

#### Paired vs baseline (tasks evaluated in both, drift excluded)

| arm vs baseline | n | b (arm wins) | c (baseline wins) | both | neither | sign test p | median wall | Wilcoxon p | $ per task | $ per solved | correct |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| llm-jev vs jev-off-tuned | 3 | 0 | 1 | 0 | 2 | 1.000 | 1m2s vs 3m38s (0.29×) | 0.250 | 0.48× | n/a | 0 vs 1 |

#### Pre-registered criteria (§1.3)

- criterion 1 — pass (discordant pairs): **FAIL** — n = 3: b = 0 (llm-jev wins), c = 1 (jev-off-tuned wins), both 0, neither 2; bar b − c ≥ 4 ∧ c ≤ 2; sign test p = 1.000 (reported, not gating)
- criterion 2 — correctness: reported (not gating) — SWE: correctness = evaluator pass (criterion 1)
- criterion 3 — wall (tasks solved by both): not evaluable — 0 tasks solved by both: mean wall n/a vs n/a (n/a, bar ≤ 1.0×); mean steps-to-solve n/a vs n/a (n/a, bar ≤ 0.5×)
- criterion 4 — cost ($ per solved, $ per task): not evaluable — $ per solved n/a vs $0.0781 (n/a, bar ≤ 0.75×); $ per task $0.0125 vs $0.0260 (0.48×, bar ≤ 1×)
- criterion S1 — refused steps (blocked + declined) on the candidate: **pass** — 0 (bar 0)
- criterion S2 — patchEmpty ≤ baseline: **pass** — 0 vs 1
- criterion S3 — zero modelDrift on the candidate: **pass** — 0 record(s) with drift (excluded from the pairs)

#### Per task

| task | llm-jev | steps | wall | $ | jev-off-tuned | steps | wall | $ |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| django__django-14725 | fail | 5 | 1m1s | $0.0129 | fail | 25 | 4m32s | $0.0335 |
| django__django-14787 | fail | 5 | 1m | $0.0097 | null | 25 | 1m56s | $0.0301 |
| django__django-15375 | fail | 5 | 1m2s | $0.0137 | fail | 25 | 3m38s | $0.0317 |
| django__django-16100 | fail | 5 | 1m40s | $0.0110 | pass | 12 | 57s | $0.0128 |


## 2. Per-task metrics from the archived run records — `/tmp/iter1/metrics.py` + `/tmp/iter1/tables.py`

### 2.1 Fresh slice (A): candidate `llm-jev`, baseline `jev-off-tuned`

## per-task (candidate)

| suite | task | pass | stop | wall s | $ tot | $ jev | jevReq | cacheHits | ranked | tested | goals | split | pl0 steps | noPatch | gen to | gen 0tok | gen s | steps |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| quixbugs | rpn_eval | True | complete | 22.3 | 0.000744 | 0.000379 | 3 | 0 | 0 | 226 | 1 | 0 | 0 | 1 | 0 | 0 | 7 | 2 |
| quixbugs | shortest_path_lengths | True | complete | 24.8 | 0.000595 | 0.000365 | 4 | 0 | 0 | 309 | 1 | 0 | 0 | 1 | 0 | 0 | 8 | 2 |
| quixbugs | shortest_paths | True | complete | 31.2 | 0.000478 | 0.000310 | 4 | 0 | 0 | 460 | 1 | 0 | 0 | 2 | 1 | 1 | 20 | 3 |
| quixbugs | sieve | True | complete | 23.2 | 0.000408 | 0.000189 | 3 | 0 | 0 | 280 | 1 | 0 | 0 | 2 | 0 | 0 | 12 | 3 |
| quixbugs | subsequences | True | complete | 22.6 | 0.000448 | 0.000254 | 3 | 0 | 0 | 228 | 1 | 0 | 0 | 2 | 1 | 1 | 20 | 3 |
| quixbugs | quicksort | True | complete | 53.4 | 0.000915 | 0.000222 | 3 | 0 | 0 | 672 | 1 | 0 | 0 | 2 | 1 | 1 | 48 | 3 |
| quixbugs | to_base | True | complete | 27.1 | 0.000418 | 0.000218 | 3 | 0 | 0 | 318 | 1 | 0 | 0 | 2 | 0 | 0 | 10 | 3 |
| quixbugs | topological_ordering | True | complete | 36.0 | 0.000917 | 0.000390 | 10 | 0 | 0 | 385 | 1 | 0 | 0 | 1 | 0 | 0 | 41 | 2 |
| ladder | deadline_queue | True | complete | 285.5 | 0.011820 | 0.006154 | 99 | 22 | 116 | 2339 | 5 | 0 | 5 | 8 | 12 | 12 | 524 | 9 |
| ladder | dep_order | True | complete | 500.3 | 0.037643 | 0.024405 | 180 | 47 | 394 | 4581 | 6 | 0 | 6 | 11 | 30 | 30 | 926 | 12 |
| ladder | csv_schema | False | max_replans | 869.2 | 0.049924 | 0.028942 | 292 | 105 | 876 | 8818 | 7 | 0 | 15 | 23 | 34 | 34 | 1559 | 24 |
| ladder | hunk_merge | True | complete | 328.1 | 0.031658 | 0.016017 | 143 | 45 | 200 | 2432 | 5 | 0 | 7 | 11 | 12 | 12 | 601 | 13 |
| ladder | token_bucket | True | complete | 89.3 | 0.005708 | 0.001425 | 26 | 1 | 120 | 2207 | 1 | 0 | 1 | 2 | 0 | 0 | 52 | 3 |
| ladder | route_match | False | replan_stop | 657.3 | 0.062733 | 0.032508 | 187 | 93 | 140 | 6022 | 6 | 0 | 12 | 19 | 22 | 22 | 1002 | 21 |
| swebench | django__django-14787 | False | replan_stop | 60.1 | 0.009725 | 0.007580 | 31 | 0 | 1419 | 5 | 1 | 0 | 0 | 4 | 7 | 7 | 180 | 5 |
| swebench | django__django-16100 | False | replan_stop | 100.3 | 0.011001 | 0.009814 | 32 | 0 | 1641 | 5 | 1 | 0 | 0 | 4 | 2 | 2 | 138 | 5 |
| swebench | django__django-14725 | False | replan_stop | 61.7 | 0.012860 | 0.009658 | 30 | 0 | 1928 | 5 | 1 | 0 | 0 | 4 | 7 | 7 | 180 | 5 |
| swebench | django__django-15375 | False | replan_stop | 62.8 | 0.013673 | 0.011154 | 33 | 0 | 1972 | 5 | 1 | 0 | 0 | 4 | 6 | 6 | 178 | 5 |

## per-task (baseline)

| suite | task | pass | stop | wall s | $ tot | $ jev | jevReq | cacheHits | ranked | tested | goals | split | pl0 steps | noPatch | gen to | gen 0tok | gen s | steps |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| quixbugs | rpn_eval | True | generator_done | 17.0 | 0.002187 | 0.000000 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 6 | 0 | 0 | 16 | 6 |
| quixbugs | quicksort | True | generator_done | 18.6 | 0.004114 | 0.000000 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 10 | 0 | 0 | 18 | 10 |
| quixbugs | shortest_paths | True | generator_done | 20.8 | 0.002648 | 0.000000 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 7 | 0 | 0 | 20 | 7 |
| quixbugs | sieve | True | generator_done | 10.7 | 0.002338 | 0.000000 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 6 | 0 | 0 | 10 | 6 |
| quixbugs | topological_ordering | True | generator_done | 6.3 | 0.001373 | 0.000000 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 4 | 0 | 0 | 6 | 4 |
| quixbugs | shortest_path_lengths | True | generator_done | 51.1 | 0.003026 | 0.000000 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 6 | 2 | 2 | 51 | 8 |
| quixbugs | subsequences | True | max_steps | 36.9 | 0.005743 | 0.000000 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 11 | 0 | 0 | 36 | 12 |
| quixbugs | to_base | True | generator_done | 46.0 | 0.002718 | 0.000000 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 7 | 1 | 1 | 45 | 8 |
| ladder | csv_schema | False | max_steps | 124.5 | 0.019451 | 0.000000 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 29 | 1 | 1 | 123 | 30 |
| ladder | deadline_queue | False | max_steps | 173.3 | 0.019021 | 0.000000 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 27 | 3 | 3 | 172 | 30 |
| ladder | dep_order | False | max_steps | 127.5 | 0.018549 | 0.000000 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 29 | 1 | 1 | 126 | 30 |
| ladder | hunk_merge | False | max_steps | 145.7 | 0.017617 | 0.000000 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 28 | 2 | 2 | 145 | 30 |
| ladder | route_match | False | max_steps | 84.5 | 0.018427 | 0.000000 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 30 | 0 | 0 | 82 | 30 |
| ladder | token_bucket | False | max_steps | 180.8 | 0.018088 | 0.000000 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 28 | 2 | 2 | 180 | 30 |
| swebench | django__django-16100 | True | generator_done | 57.6 | 0.012811 | 0.000000 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 12 | 0 | 0 | 41 | 12 |
| swebench | django__django-14787 | None | max_steps | 116.4 | 0.030089 | 0.000000 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 23 | 1 | 1 | 113 | 25 |
| swebench | django__django-14725 | False | max_steps | 272.6 | 0.033546 | 0.000000 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 22 | 3 | 3 | 269 | 25 |
| swebench | django__django-15375 | False | max_steps | 218.4 | 0.031726 | 0.000000 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 23 | 2 | 2 | 214 | 25 |

## paired (n=18): b=4 c=1 both=8 neither=5 sign p=0.1875
cand pass 12/18 Wilson (0.4374946729086293, 0.8372122525198085)
base pass 9/18 Wilson (0.2903102150111464, 0.7096897849888536)
median wall all: cand 60.9s base 71.1s
median wall both-solved (n=8): cand 26.0s base 19.7s ratio 1.318
per-task ratio: min 0.486 median 1.406 max 5.756; cand slower on 5/8
$ total: cand 0.251668 base 0.243474
Jev requests: cand 1086 base 0
discordant list: cand-wins ['deadline_queue', 'dep_order', 'hunk_merge', 'token_bucket'] base-wins ['django__django-16100']

## Jev by question family (candidate, pooled)

| family | requests | questions | $ | cached |
|---|---|---|---|---|
| `propose|buggy_line` | 289 | 289 | 0.007037 | 118 |
| `propose|where` | 266 | 266 | 0.006911 | 109 |
| `propose|fix` | 265 | 265 | 0.013215 | 5 |
| `propose|slot_*` | 229 | 1460 | 0.070155 | 10 |
| `propose|attack_first` | 81 | 81 | 0.001700 | 43 |
| `propose|sketch` | 51 | 102 | 0.004999 | 3 |
| `risk|destructive` | 40 | 80 | 0.004783 | 0 |
| `propose|candidate_*` | 33 | 6960 | 0.023283 | 0 |
| `replan|next_move` | 20 | 120 | 0.002787 | 0 |
| `propose|src/cells.py` | 16 | 80 | 0.000453 | 9 |
| `propose|src/pattern.py` | 16 | 64 | 0.000332 | 10 |
| `judge|done_0` | 10 | 46 | 0.001723 | 0 |
| `propose|src/graph.py` | 10 | 50 | 0.000377 | 4 |
| `propose|src/apply.py` | 10 | 60 | 0.000471 | 2 |
| `propose|src/job.py` | 8 | 48 | 0.000472 | 0 |
| `propose|genuine_fix` | 8 | 25 | 0.000643 | 0 |
| `complete|task_complete` | 5 | 5 | 0.000423 | 0 |
| `propose|general_cand_*` | 5 | 5 | 0.000288 | 0 |
| `propose|line_4` | 3 | 35 | 0.000464 | 0 |
| `propose|line_2` | 3 | 19 | 0.000294 | 0 |
| `propose|src/slack.py` | 3 | 15 | 0.000195 | 0 |
| `propose|src/hunks.py` | 3 | 15 | 0.000192 | 0 |
| `propose|is_reproduction_0` | 2 | 11 | 0.000198 | 0 |
| `propose|django/middleware/csrf.py` | 2 | 219 | 0.000489 | 0 |
| `propose|line_3` | 1 | 11 | 0.000146 | 0 |
| `propose|topological_ordering.py` | 1 | 2 | 0.000033 | 0 |
| `propose|src/bucket.py` | 1 | 5 | 0.000062 | 0 |
| `propose|django/template/backends/django.py` | 1 | 105 | 0.000231 | 0 |
| `propose|django/contrib/admin/templatetags/log.py` | 1 | 250 | 0.000593 | 0 |
| `propose|django/contrib/contenttypes/fields.py` | 1 | 250 | 0.000616 | 0 |
| `propose|django/contrib/staticfiles/management/commands/runserver.py` | 1 | 250 | 0.000561 | 0 |
| `propose|django/utils/decorators.py` | 1 | 5 | 0.000072 | 0 |
| `propose|django/contrib/sitemaps/management/commands/__init__.py` | 1 | 250 | 0.000564 | 0 |
| `propose|django/contrib/admin/templatetags/base.py` | 1 | 250 | 0.000577 | 0 |
| `propose|django/contrib/auth/apps.py` | 1 | 250 | 0.000616 | 0 |
| `propose|django/contrib/admin/views/main.py` | 1 | 5 | 0.000065 | 0 |
| `propose|django/template/backends/base.py` | 1 | 108 | 0.000232 | 0 |
| `propose|django/contrib/staticfiles/handlers.py` | 1 | 250 | 0.000560 | 0 |
| `propose|django/contrib/auth/urls.py` | 1 | 250 | 0.000609 | 0 |
| `propose|django/contrib/admin/forms.py` | 1 | 250 | 0.000590 | 0 |
| `propose|django/forms/formsets.py` | 1 | 5 | 0.000070 | 0 |
| `propose|django/contrib/admin/models.py` | 1 | 250 | 0.000596 | 0 |
| `propose|django/contrib/admin/templatetags/admin_modify.py` | 1 | 250 | 0.000632 | 0 |
| `propose|django/contrib/sessions/migrations/0001_initial.py` | 1 | 250 | 0.000585 | 0 |
| `propose|django/db/models/sql/query.py` | 1 | 5 | 0.000090 | 0 |

replan next_move: {'gather_context': 14, 'change_approach': 2, 'stop_and_report': 4}
task_complete asked: 15
ranked total 8806 vs tested total 29297
cacheHits total 313; cached rows 313
generator: calls 290 samples 290 valid 80 timeouts 135 zero-token-timeouts 135 sample-s 5506 of which timeout-s 3501
stop reasons (candidate): {'complete': 12, 'max_replans': 1, 'replan_stop': 5}
stop reasons (baseline): {'generator_done': 8, 'max_steps': 10}

### 2.2 In-sample regression arm (B): `llm-jev` over the original 28

## per-task (candidate)

| suite | task | pass | stop | wall s | $ tot | $ jev | jevReq | cacheHits | ranked | tested | goals | split | pl0 steps | noPatch | gen to | gen 0tok | gen s | steps |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| quixbugs | find_in_sorted | True | complete | 26.0 | 0.000678 | 0.000328 | 4 | 0 | 0 | 482 | 1 | 0 | 0 | 1 | 0 | 0 | 10 | 2 |
| quixbugs | bucketsort | True | complete | 30.5 | 0.000670 | 0.000240 | 3 | 0 | 0 | 295 | 1 | 0 | 0 | 2 | 0 | 0 | 9 | 3 |
| quixbugs | detect_cycle | True | complete | 39.9 | 0.000492 | 0.000304 | 9 | 0 | 0 | 136 | 1 | 0 | 0 | 2 | 1 | 1 | 20 | 3 |
| quixbugs | gcd | True | complete | 15.4 | 0.000426 | 0.000179 | 3 | 0 | 0 | 176 | 1 | 0 | 0 | 2 | 0 | 0 | 14 | 3 |
| quixbugs | kth | True | complete | 30.8 | 0.000505 | 0.000281 | 3 | 0 | 0 | 449 | 1 | 0 | 0 | 2 | 1 | 1 | 20 | 3 |
| quixbugs | bitcount | True | complete | 84.5 | 0.000869 | 0.000192 | 3 | 0 | 0 | 577 | 1 | 0 | 0 | 2 | 2 | 2 | 55 | 3 |
| quixbugs | mergesort | True | complete | 80.5 | 0.001275 | 0.000465 | 4 | 0 | 10 | 685 | 1 | 0 | 0 | 2 | 1 | 1 | 51 | 3 |
| quixbugs | wrap | True | complete | 71.4 | 0.001324 | 0.000480 | 5 | 0 | 0 | 1010 | 1 | 0 | 0 | 1 | 3 | 3 | 80 | 2 |
| quixbugs | lis | True | complete | 161.3 | 0.002959 | 0.001468 | 24 | 2 | 153 | 2382 | 1 | 0 | 0 | 2 | 5 | 5 | 162 | 3 |
| quixbugs | shortest_path_length | True | complete | 274.2 | 0.006307 | 0.002460 | 50 | 17 | 270 | 5452 | 1 | 0 | 3 | 5 | 4 | 4 | 386 | 7 |
| ladder | events | True | complete | 47.1 | 0.000903 | 0.000309 | 7 | 0 | 0 | 695 | 1 | 0 | 0 | 1 | 1 | 1 | 25 | 2 |
| ladder | grades | True | complete | 24.9 | 0.000915 | 0.000350 | 8 | 0 | 0 | 363 | 1 | 0 | 0 | 1 | 0 | 0 | 25 | 2 |
| ladder | calendar_utils | True | complete | 207.5 | 0.003375 | 0.001386 | 31 | 0 | 52 | 3524 | 3 | 0 | 0 | 3 | 4 | 4 | 126 | 6 |
| ladder | inventory | True | complete | 143.4 | 0.001740 | 0.000827 | 18 | 0 | 0 | 2310 | 2 | 0 | 0 | 2 | 3 | 3 | 86 | 4 |
| ladder | profiles | True | complete | 21.2 | 0.000800 | 0.000275 | 7 | 0 | 0 | 218 | 1 | 0 | 0 | 1 | 0 | 0 | 29 | 2 |
| ladder | stats | True | complete | 31.3 | 0.000892 | 0.000416 | 8 | 0 | 0 | 290 | 1 | 0 | 0 | 1 | 1 | 1 | 27 | 2 |
| ladder | account | True | complete | 263.3 | 0.003309 | 0.001024 | 23 | 16 | 152 | 4415 | 2 | 0 | 2 | 5 | 2 | 2 | 105 | 7 |
| ladder | tagcloud | True | complete | 11.0 | 0.000599 | 0.000422 | 9 | 0 | 0 | 14 | 1 | 0 | 0 | 1 | 0 | 0 | 9 | 2 |
| ladder | shipping | True | complete | 79.9 | 0.000845 | 0.000383 | 9 | 0 | 10 | 1418 | 1 | 0 | 0 | 2 | 1 | 1 | 40 | 3 |
| ladder | units | True | complete | 24.7 | 0.000855 | 0.000441 | 9 | 0 | 0 | 335 | 1 | 0 | 0 | 1 | 0 | 0 | 19 | 2 |
| ladder | textstats | True | complete | 95.6 | 0.002013 | 0.000883 | 18 | 0 | 0 | 1848 | 2 | 0 | 0 | 2 | 2 | 2 | 47 | 4 |
| ladder | table | True | complete | 164.2 | 0.003322 | 0.001002 | 20 | 19 | 200 | 4193 | 1 | 0 | 2 | 3 | 1 | 1 | 101 | 4 |
| swebench | sympy__sympy-15345 | True | complete | 156.0 | 0.007357 | 0.002795 | 19 | 0 | 20 | 776 | 1 | 0 | 0 | 1 | 0 | 0 | 76 | 2 |
| swebench | sympy__sympy-17139 | True | complete | 141.6 | 0.006812 | 0.004234 | 18 | 0 | 0 | 4 | 1 | 0 | 0 | 1 | 1 | 1 | 103 | 2 |
| swebench | sympy__sympy-11618 | True | complete | 59.5 | 0.004554 | 0.002481 | 17 | 0 | 0 | 4 | 1 | 0 | 0 | 1 | 0 | 0 | 58 | 2 |
| swebench | sympy__sympy-19954 | True | complete | 131.2 | 0.007665 | 0.003996 | 18 | 0 | 0 | 4 | 1 | 0 | 0 | 1 | 0 | 0 | 39 | 2 |
| swebench | django__django-15315 | True | complete | 35.5 | 0.006103 | 0.003500 | 17 | 0 | 0 | 1 | 1 | 0 | 0 | 1 | 0 | 0 | 21 | 2 |
| swebench | django__django-15128 | False | replan_stop | 129.4 | 0.010715 | 0.006139 | 30 | 14 | 0 | 341 | 1 | 0 | 2 | 7 | 4 | 4 | 200 | 7 |

## Jev by question family (candidate, pooled)

| family | requests | questions | $ | cached |
|---|---|---|---|---|
| `propose|buggy_line` | 145 | 145 | 0.005535 | 24 |
| `propose|fix` | 94 | 94 | 0.003670 | 19 |
| `propose|where` | 71 | 71 | 0.005787 | 12 |
| `judge|done_0` | 24 | 63 | 0.003218 | 0 |
| `propose|attack_first` | 18 | 18 | 0.000439 | 4 |
| `propose|general_cand_*` | 11 | 11 | 0.000734 | 0 |
| `complete|task_complete` | 8 | 8 | 0.000689 | 0 |
| `propose|genuine_fix` | 8 | 30 | 0.001071 | 0 |
| `propose|is_reproduction_0` | 6 | 45 | 0.000709 | 0 |
| `risk|destructive` | 6 | 12 | 0.000705 | 0 |
| `propose|line_3` | 4 | 33 | 0.000339 | 1 |
| `propose|line_2` | 4 | 30 | 0.000459 | 0 |
| `propose|shortest_path_length.py` | 4 | 8 | 0.000064 | 2 |
| `replan|next_move` | 4 | 24 | 0.000568 | 0 |
| `propose|src/calendar_utils.py` | 3 | 6 | 0.000098 | 0 |
| `propose|src/account.py` | 3 | 6 | 0.000070 | 1 |
| `propose|django/template/backends/dummy.py` | 3 | 322 | 0.000518 | 1 |
| `propose|src/inventory.py` | 2 | 4 | 0.000061 | 0 |
| `propose|src/textstats.py` | 2 | 4 | 0.000068 | 0 |
| `propose|src/fmt.py` | 2 | 6 | 0.000042 | 1 |
| `propose|sympy/combinatorics/perm_groups.py` | 2 | 255 | 0.000678 | 0 |
| `propose|django/db/models/expressions.py` | 2 | 500 | 0.000635 | 1 |
| `propose|django/contrib/sites/migrations/__init__.py` | 2 | 500 | 0.000612 | 1 |
| `propose|django/contrib/auth/migrations/0003_alter_user_email_max_length.py` | 2 | 500 | 0.000669 | 1 |
| `propose|django/db/models/sql/query.py` | 2 | 15 | 0.000317 | 0 |
| `propose|detect_cycle.py` | 1 | 2 | 0.000031 | 0 |
| `propose|line_4` | 1 | 19 | 0.000242 | 0 |
| `propose|insert_after_1` | 1 | 5 | 0.000178 | 0 |
| `propose|src/events.py` | 1 | 2 | 0.000039 | 0 |
| `propose|src/grades.py` | 1 | 2 | 0.000033 | 0 |
| `propose|src/profiles.py` | 1 | 2 | 0.000036 | 0 |
| `propose|src/stats.py` | 1 | 2 | 0.000035 | 0 |
| `propose|src/tagcloud.py` | 1 | 2 | 0.000033 | 0 |
| `propose|src/shipping.py` | 1 | 2 | 0.000033 | 0 |
| `propose|src/units.py` | 1 | 2 | 0.000036 | 0 |
| `propose|sympy/core/symbol.py` | 1 | 250 | 0.000562 | 0 |
| `propose|sympy/integrals/rubi/parsetools/generate_rules.py` | 1 | 250 | 0.000627 | 0 |
| `propose|sympy/polys/benchmarks/__init__.py` | 1 | 245 | 0.000566 | 0 |
| `propose|sympy/printing/mathematica.py` | 1 | 5 | 0.000066 | 0 |
| `propose|sympy/vector/orienters.py` | 1 | 4 | 0.000087 | 0 |
| `propose|sympy/core/expr.py` | 1 | 250 | 0.000619 | 0 |
| `propose|sympy/integrals/manualintegrate.py` | 1 | 250 | 0.000684 | 0 |
| `propose|sympy/plotting/pygletplot/plot_object.py` | 1 | 250 | 0.000640 | 0 |
| `propose|sympy/simplify/fu.py` | 1 | 5 | 0.000144 | 0 |
| `propose|sympy/printing/pretty/stringpict.py` | 1 | 126 | 0.000293 | 0 |
| `propose|sympy/printing/python.py` | 1 | 250 | 0.000564 | 0 |
| `propose|sympy/matrices/benchmarks/__init__.py` | 1 | 250 | 0.000604 | 0 |
| `propose|sympy/geometry/point.py` | 1 | 5 | 0.000061 | 0 |
| `propose|sympy/strategies/util.py` | 1 | 60 | 0.000175 | 0 |
| `propose|sympy/integrals/meijerint_doc.py` | 1 | 250 | 0.000646 | 0 |
| `propose|sympy/physics/vector/frame.py` | 1 | 250 | 0.000612 | 0 |
| `propose|django/contrib/auth/mixins.py` | 1 | 250 | 0.000615 | 0 |
| `propose|django/contrib/staticfiles/management/commands/runserver.py` | 1 | 250 | 0.000562 | 0 |
| `propose|django/contrib/admin/models.py` | 1 | 250 | 0.000597 | 0 |
| `propose|django/db/models/fields/__init__.py` | 1 | 5 | 0.000082 | 0 |

replan next_move: {'gather_context': 4}
task_complete asked: 32
ranked total 867 vs tested total 32397
cacheHits total 68; cached rows 68
generator: calls 110 samples 110 valid 52 timeouts 37 zero-token-timeouts 37 sample-s 1944 of which timeout-s 895
stop reasons (candidate): {'complete': 27, 'replan_stop': 1}

## 3. Verdict scripts

```
# node_modules/.bin/tsx experiments/inspect/quixbugs-verdicts.mts bench/results/<dir>   (one dir per call)
=== iter1-fresh-llm-jev-quixbugs ===
quicksort                    solved equivalent      differs (differs at token 47: 'equal' vs 'greater'); reference cases: patched 13/13, reference 13/13; identic…
rpn_eval                     solved equivalent      differs (differs at token 110: 'b' vs 'a'); reference cases: patched 6/6, reference 6/6; identical outputs on…
shortest_path_lengths        solved gold-identical  token-identical to correct/shortest_path_lengths.py (from model_patch.diff)
shortest_paths               solved gold-identical  token-identical to correct/shortest_paths.py (from model_patch.diff)
sieve                        solved gold-identical  token-identical to correct/sieve.py (from model_patch.diff)
subsequences                 solved gold-identical  token-identical to correct/subsequences.py (from model_patch.diff)
to_base                      solved gold-identical  token-identical to correct/to_base.py (from model_patch.diff)
topological_ordering         solved gold-identical  token-identical to correct/topological_ordering.py (from model_patch.diff)

Totals: solved 8/8; gold-identical 6, equivalent 2, overfit 0, unverified 0, miss 0.
Correct by this script: 8/8 (gold-identical + equivalent); 0 more pass the reference cases but differ from the reference where nothing could be compared; 0 overfit the reference cases.
written /Users/prateekjannu/Documents/vscode/JevCode/.claude/worktrees/iter1-clean/bench/results/iter1-fresh-llm-jev-quixbugs/verdicts.md
=== iter1-fresh-jev-off-tuned-quixbugs ===
quicksort                    solved gold-identical  token-identical to correct/quicksort.py (from model_patch.diff)
rpn_eval                     solved equivalent      differs (differs at token 110: 'b' vs 'a'); reference cases: patched 6/6, reference 6/6; identical outputs on…
shortest_path_lengths        solved gold-identical  token-identical to correct/shortest_path_lengths.py (from model_patch.diff)
shortest_paths               solved gold-identical  token-identical to correct/shortest_paths.py (from model_patch.diff)
sieve                        solved equivalent      differs (differs at token 33: 'for' vs '>'); reference cases: patched 6/6, reference 6/6; identical outputs o…
subsequences                 solved equivalent      differs (differs at token 39: ')' vs '+'); reference cases: patched 12/12, reference 12/12; identical outputs…
to_base                      solved equivalent      differs (differs at token 13: 'if' vs 'result'); reference cases: patched 10/10, reference 10/10; identical o…
topological_ordering         solved gold-identical  token-identical to correct/topological_ordering.py (from model_patch.diff)

Totals: solved 8/8; gold-identical 4, equivalent 4, overfit 0, unverified 0, miss 0.
Correct by this script: 8/8 (gold-identical + equivalent); 0 more pass the reference cases but differ from the reference where nothing could be compared; 0 overfit the reference cases.
written /Users/prateekjannu/Documents/vscode/JevCode/.claude/worktrees/iter1-clean/bench/results/iter1-fresh-jev-off-tuned-quixbugs/verdicts.md

=== iter1-insample-llm-jev-quixbugs ===
bitcount                     solved gold-identical  token-identical to correct/bitcount.py (from model_patch.diff)
bucketsort                   solved gold-identical  token-identical to correct/bucketsort.py (from model_patch.diff)
detect_cycle                 solved overfit         differs (differs at token 21: '.' vs 'is'); reference cases: patched 6/6, reference 6/6; 1/500 of 500 random …
find_in_sorted               solved gold-identical  token-identical to correct/find_in_sorted.py (from model_patch.diff)
gcd                          solved gold-identical  token-identical to correct/gcd.py (from model_patch.diff)
kth                          solved gold-identical  token-identical to correct/kth.py (from model_patch.diff)
lis                          solved gold-identical  token-identical to correct/lis.py (from model_patch.diff)
mergesort                    solved gold-identical  token-identical to correct/mergesort.py (from model_patch.diff)
shortest_path_length         solved gold-identical  token-identical to correct/shortest_path_length.py (from model_patch.diff)
wrap                         solved gold-identical  token-identical to correct/wrap.py (from model_patch.diff)

Totals: solved 10/10; gold-identical 9, equivalent 0, overfit 1, unverified 0, miss 0.
Correct by this script: 9/10 (gold-identical + equivalent); 0 more pass the reference cases but differ from the reference where nothing could be compared; 1 overfit the reference cases.
written /Users/prateekjannu/Documents/vscode/JevCode/.claude/worktrees/iter1-clean/bench/results/iter1-insample-llm-jev-quixbugs/verdicts.md
exit 0
```

```
# node_modules/.bin/tsx experiments/inspect/ladder-verdicts.mts bench/results/<dir>
=== iter1-fresh-llm-jev-ladder-long2 ===
csv_schema         short miss   miss            a committed patch still fails; max_replans after 24 steps
deadline_queue     short solved equivalent      differs from gold in schedule.py (differs at token 117: '==' vs '<='); identical results, exception classes and post-ca…
dep_order          short solved equivalent      differs from gold in layers.py (differs at token 97: 'max' vs '1'); identical results, exception classes and post-call …
hunk_merge         short solved equivalent      differs from gold in hunks.py (differs at token 133: 'first_line' vs 'index'), merge.py (differs at token 193: 'def' vs…
route_match        short miss   miss            a committed patch still fails; replan_stop after 21 steps
token_bucket       short solved overfit         strong: differs from gold in bucket.py (differs at token 172: 'self' vs 'if'); 8/644 differ (Limiter.allow 2, Limiter.r…

short tier: solved 4/6, correct 3/6 (gold-identical 0, equivalent 3); overfit 1 — strong 1 (token_bucket), weak only 0; unverified 0, miss 2
long tier: solved 0/0, correct 0/0 (gold-identical 0, equivalent 0); overfit 0 — strong 0, weak only 0; unverified 0, miss 0
all tier: solved 4/6, correct 3/6 (gold-identical 0, equivalent 3); overfit 1 — strong 1 (token_bucket), weak only 0; unverified 0, miss 2
written /Users/prateekjannu/Documents/vscode/JevCode/.claude/worktrees/iter1-clean/bench/results/iter1-fresh-llm-jev-ladder-long2/verdicts.md
=== iter1-fresh-jev-off-tuned-ladder-long2 ===
csv_schema         short miss   miss            no patch committed; max_steps after 30 steps
deadline_queue     short miss   miss            a committed patch still fails; max_steps after 30 steps
dep_order          short miss   miss            no patch committed; max_steps after 30 steps
hunk_merge         short miss   miss            no patch committed; max_steps after 30 steps
route_match        short miss   miss            a committed patch still fails; max_steps after 30 steps
token_bucket       short miss   miss            no patch committed; max_steps after 30 steps

short tier: solved 0/6, correct 0/6 (gold-identical 0, equivalent 0); overfit 0 — strong 0, weak only 0; unverified 0, miss 6
long tier: solved 0/0, correct 0/0 (gold-identical 0, equivalent 0); overfit 0 — strong 0, weak only 0; unverified 0, miss 0
all tier: solved 0/6, correct 0/6 (gold-identical 0, equivalent 0); overfit 0 — strong 0, weak only 0; unverified 0, miss 6
written /Users/prateekjannu/Documents/vscode/JevCode/.claude/worktrees/iter1-clean/bench/results/iter1-fresh-jev-off-tuned-ladder-long2/verdicts.md
=== iter1-insample-llm-jev-ladder ===
account            short solved equivalent      differs from gold in account.py (differs at token 245: 'start' vs '1'); identical results, exception classes and post-c…
calendar_utils     short solved equivalent      differs from gold in calendar_utils.py (differs at token 257: 'day' vs 'return'); identical results, exception classes …
events             short solved gold-identical  token-identical to gold/ (events.py; from model_patch.diff (535 bytes))
grades             short solved gold-identical  token-identical to gold/ (grades.py; from model_patch.diff (814 bytes))
inventory          short solved equivalent      differs from gold in inventory.py (differs at token 416: 'number' vs 'start'); identical results, exception classes and…
profiles           short solved equivalent      differs from gold in profiles.py (differs at token 75: 'nick' vs 'if'); identical results, exception classes and post-c…
shipping           short solved gold-identical  token-identical to gold/ (shipping.py; from model_patch.diff (509 bytes))
stats              short solved overfit         weak only: differs from gold in stats.py (differs at token 81: 'ordered' vs 'if'); 2/111 differ (median 1, summary 1; 2…
table              short solved gold-identical  token-identical to gold/ (fmt.py, table.py; from model_patch.diff (1052 bytes))
tagcloud           short solved equivalent      differs from gold in tagcloud.py (differs at token 8: 'dataclasses' vs 'collections'); identical results, exception cla…
textstats          short solved equivalent      differs from gold in textstats.py (differs at token 266: '+' vs '-'); identical results, exception classes and post-cal…
units              short solved equivalent      differs from gold in units.py (differs at token 262: 'float' vs 'text'); identical results, exception classes and post-…

short tier: solved 12/12, correct 11/12 (gold-identical 4, equivalent 7); overfit 1 — strong 0, weak only 1 (stats); unverified 0, miss 0
long tier: solved 0/0, correct 0/0 (gold-identical 0, equivalent 0); overfit 0 — strong 0, weak only 0; unverified 0, miss 0
all tier: solved 12/12, correct 11/12 (gold-identical 4, equivalent 7); overfit 1 — strong 0, weak only 1 (stats); unverified 0, miss 0
written /Users/prateekjannu/Documents/vscode/JevCode/.claude/worktrees/iter1-clean/bench/results/iter1-insample-llm-jev-ladder/verdicts.md
```

## 4. Ring 1 — `quick.mts --ring 1` ($0, `JEVCODE_WARM=off`)

```

Ring 1 — the `--jev off` safety gate, paired against the same tasks with Jev on (no network, no API)

  --jev off keeps what Jev solves, quixbugs  Jev on 2/3 pass → off 0/3; lost gcd, mergesort  every task Jev-on solves, Jev-off solves FAIL
    only slower, quixbugs                    no task solved by both arms                     report (a router fallback costs wall, never correctness) ·
    faster AND unsolved, quixbugs            gcd, mergesort                                  the false-green signature: replanned into the cap FAIL
  --jev off keeps what Jev solves, ladder    Jev on 2/2 pass → off 1/2; lost units           every task Jev-on solves, Jev-off solves FAIL
    only slower, ladder                      0.84× the Jev-on wall over 1 task(s)            report (a router fallback costs wall, never correctness) ·
    faster AND unsolved, ladder              units                                           the false-green signature: replanned into the cap FAIL
  replay of the 28 head-to-head run dirs     not landed                                      src/loop/replay.ts + `inspect --replay` (needs src/cli/**) ·

  pending Ring-0 probes:
    py-load          wave S3 (M7): loadPythonFiles cold / warm-parse / stat-gated — owner: the S3 indexing wave
    jev-batch        wave S4 (M9): 5 sequential vs 1 merged vs 5 concurrent, plus the cache hit — owner: the S4 router wave
    llm-sample       wave S2 (M1–M4): 6 real propose_fix calls, --live only (≈ $0.003) — owner: the S2 generator wave

  deferred by wave S0 (§6 S0 names it; this tree does not have it):
    imagesMs reduction (p95 19.9–24.5 ms, target 15 ms)
      the serial 15 MiB pre-image copy is in src/checkpoint/images.ts, owned by another branch in flight; S0 instrumented it (`images:pre` / `images:post` spans) and did not reduce it
    src/loop/replay.ts + `jevcode inspect --replay <run-id>` (M15, Ring 1 proper)
      the flag lands in src/cli/inspect.ts, owned by another branch; the `--jev off` gate below is the part of Ring 1 that is free of it
    the TTFB callback on src/provider/sse.ts, and `--quick` in src/bench/cli.ts
      both feed fields in src/core/types.ts (§4.4), owned by another branch; they land with the S2 generator wave

quick: a gate failed (git 751e3bf)
exit 1
```

## 5. Ring 2 — `quick.mts --ring 2 --live --spend-cap 0.05` (`JEVCODE_WARM=off`)

```

Ring 2 — the tiny live tasks (LIVE)

  task            pass  steps   wall      wall/step    $        jev req  jevMs   harnessMs  verdict     vs baseline
  gcd             true      2    15.7 s      7.8 s   $0.0002        3 673.9 ms   107.7 ms  —           -2 %
  kth             true      2    27.1 s     13.5 s   $0.0003        3 565.0 ms    96.3 ms  —           -18 %
  mergesort       true      3    90.9 s     30.3 s   $0.0010        9    1.9 s    88.6 ms  —           -49 %
  tagcloud        true      2     3.7 s      1.8 s   $0.0004        9    1.8 s    84.6 ms  —           -67 %
  units           true      6    99.4 s     16.6 s   $0.0013       26    4.9 s   156.1 ms  —           +352 %

  accept rule (§5 step 5):
    median wall −≥ 10 % on ≥ 3 tasks           3/5  met
    no verdict changed                          0 change(s)  met
    overfit count not increased (baseline 5)    0  met
    Jev requests not increased                  1 task(s) up  NOT met
    screenMismatches = 0, scopeUnusable = 0     not recorded before wave S1

  REJECT — and run it twice before believing it (§5 step 4)

  pending Ring-2 tasks:
    q-self-edit      this repo, offline: needs the jest/vitest scope builders of wave S1
    q-drifted-edit   fixture + mock provider: needs the M11 replacer ladder of wave S5

  pending Ring-0 probes:
    py-load          wave S3 (M7): loadPythonFiles cold / warm-parse / stat-gated — owner: the S3 indexing wave
    jev-batch        wave S4 (M9): 5 sequential vs 1 merged vs 5 concurrent, plus the cache hit — owner: the S4 router wave
    llm-sample       wave S2 (M1–M4): 6 real propose_fix calls, --live only (≈ $0.003) — owner: the S2 generator wave

  deferred by wave S0 (§6 S0 names it; this tree does not have it):
    imagesMs reduction (p95 19.9–24.5 ms, target 15 ms)
      the serial 15 MiB pre-image copy is in src/checkpoint/images.ts, owned by another branch in flight; S0 instrumented it (`images:pre` / `images:post` spans) and did not reduce it
    src/loop/replay.ts + `jevcode inspect --replay <run-id>` (M15, Ring 1 proper)
      the flag lands in src/cli/inspect.ts, owned by another branch; the `--jev off` gate below is the part of Ring 1 that is free of it
    the TTFB callback on src/provider/sse.ts, and `--quick` in src/bench/cli.ts
      both feed fields in src/core/types.ts (§4.4), owned by another branch; they land with the S2 generator wave

quick: a gate failed (git 751e3bf)
exit 1
```

## 6. Guard and goal events (grep over the 58 run transcripts)

```
# grep -h "synth guard:" <all transcripts>
  12 g1: the budget reserve is spent but the held suspect donor/statement_donor at lis.py:12:insert (general 0.27 < 0.3) is not released; the step ends on 
   3 g3: mutation/statement_template at src/textstats.py:35:insert mutates an argument the pre-patch code left alone — recorded as a suspicion signal for t
   2 g5: mutation/statement_template at src/plan.py:13:insert mutates an argument the pre-patch code left alone — recorded as a suspicion signal for the ar
   2 g2: 2 passers in one behaviour cluster with a code seed and an LLM candidate (probe 32 inputs, 2/2 signatures); committing the LLM member llm/sample_0
   2 g1: the budget reserve is spent but the held suspect llm/sample_3_0 at sympy/printing/mathematica.py:102:replace (general 0.24 < 0.3) is not released;
   2 g1: holds the partial mutation/off_by_one_atom at lis.py:12:replace (adds_special_case; general 0.08 < 0.3); not committed
   1 g7: holds the lone passer llm/sample_1_0 at src/policy.py:35:replace as suspect (deletes_statement, adds_special_case; general 0.45 < 0.7); searching 
   1 g7: harvested 70 test calls over 13 functions of src.cells, src.infer, src.reader, src.schema (tests/test_schema.py); 32 perturbed inputs for the prob
   1 g7: harvested 7 test calls over 14 functions of src.bucket, src.clock, src.limiter, src.policy (tests/test_policy.py); 26 perturbed inputs for the pro
   1 g7: arbitrated 2 passers (1 held) in 1 cluster (probe 26 inputs, 2/2 signatures); escape 0.17, max general 0.39; pick llm/sample_0_0 at src/policy.py:
   1 g7: arbitrated 2 passers (0 held) in 1 cluster (probe 32 inputs, 2/2 signatures); escape 0.90, max general 0.08; all-overfit signature
   1 g7: all-overfit signature (escape 0.90 ≥ 0.5, max general 0.08 < 0.3); dropping the 2 passers (kept in tried, none is committed); searching on
   1 g6: the step ends on its budget; committing the held passer as possible overfit
   1 g6: holds the lone passer llm/sample_1_0 at src/slack.py:11:replace as suspect (deletes_statement, adds_special_case; general 0.48 < 0.7); searching o
   1 g6: harvested 67 test calls over 18 functions of src.apply, src.hunks, src.merge, src.preview, src.text (tests/test_merge.py); 32 perturbed inputs for
   1 g6: arbitrated 2 passers (0 held) in 1 cluster (probe 32 inputs, 2/2 signatures); escape 0.47, max general 0.20; pick llm/sample_1_0 at src/hunks.py:3
   1 g5: harvested 46 test calls over 15 functions of src.graph, src.layers, src.order, src.plan (tests/test_plan.py); 32 perturbed inputs for the probe
   1 g5: arbitrated 2 passers (0 held) in 2 clusters (probe 32 inputs, 2/2 signatures, 4 differing inputs shown); escape 0.87, max general 0.08; all-overfi
   1 g5: all-overfit signature (escape 0.87 ≥ 0.5, max general 0.08 < 0.3); dropping the 2 passers (kept in tried, none is committed); searching on
   1 g5: 2 passers (0 held) in 2 behaviour clusters (probe 32 inputs, 2/2 signatures; cluster_1 1 member/support 1, cluster_2 1 member/support 1); the clus
   1 g4: template/insert_return at src/inventory.py:48:insert mutates an argument the pre-patch code left alone — recorded as a suspicion signal for the ar
   1 g4: holds the lone passer llm/sample_1_0 at src/hunks.py:31:replace as suspect (deletes_statement, adds_special_case; general 0.22 < 0.3): never relea
   1 g4: holds the lone passer llm/sample_0_0 at src/layers.py:21:replace as suspect (adds_special_case; general 0.23 < 0.3): never released on the budget 
   1 g4: harvested 38 test calls over 15 functions of src.graph, src.layers, src.order, src.plan (tests/test_layers.py); 32 perturbed inputs for the probe
   1 g4: harvested 20 test calls over 7 functions of src.inventory (tests/test_inventory.py); 32 perturbed inputs for the probe
   1 g4: donor/statement_donor at src/inventory.py:48:insert mutates an argument the pre-patch code left alone — recorded as a suspicion signal for the arb
   1 g4: arbitrated 2 passers (1 held) in 1 cluster (probe 32 inputs, 2/2 signatures); escape 0.29, max general 0.33; pick llm/sample_0_0 at src/layers.py:
   1 g4: arbitrated 2 passers (0 held) in 1 cluster (probe 32 inputs, 2/2 signatures); escape 0.96, max general 0.03; all-overfit signature
   1 g4: all-overfit signature (escape 0.96 ≥ 0.5, max general 0.03 < 0.3); dropping the 2 passers (kept in tried, none is committed); searching on
   1 g3: lone passer mutation/off_by_one_atom at src/textstats.py:35:replace looks adds_special_case but general 0.85 ≥ 0.3 keeps it
   1 g3: holds the lone passer mutation/off_by_one_atom at src/textstats.py:35:replace until its site's seed sources ran
   1 g3: holds the lone passer mutation/drop_term at src/textstats.py:35:replace until its site's seed sources ran
   1 g3: harvested 20 test calls over 8 functions of src.textstats (tests/test_textstats.py); 32 perturbed inputs for the probe
   1 g3: harvested 20 test calls over 7 functions of src.tagcloud (tests/test_tagcloud.py); 32 perturbed inputs for the probe
   1 g3: arbitrated 3 passers (0 held) in 3 clusters (probe 32 inputs, 3/3 signatures, 1 differing input shown); escape 0.96, max general 0.06; all-overfit
   1 g3: arbitrated 2 passers (0 held) in 1 cluster (probe 32 inputs, 2/2 signatures); escape 0.00, max general 0.95; pick template/import_insert at src/ta
   1 g3: all-overfit signature (escape 0.96 ≥ 0.5, max general 0.06 < 0.3); dropping the 3 passers (kept in tried, none is committed); searching on
   1 g3: 3 passers (0 held) in 3 behaviour clusters (probe 32 inputs, 3/3 signatures; cluster_1 1 member/support 1, cluster_2 1 member/support 1, cluster_3
   1 g2: mutation/argument_arity at src/account.py:44:replace mutates an argument the pre-patch code left alone — recorded as a suspicion signal for the ar
   1 g2: llm/sample_0_0 at src/account.py:44:replace mutates an argument the pre-patch code left alone — recorded as a suspicion signal for the arbitration
   1 g2: harvested 34 test calls over 18 functions of src.apply, src.hunks, src.merge, src.preview, src.text (tests/test_hunks.py); 32 perturbed inputs for
   1 g2: harvested 21 test calls over 8 functions of src.textstats (tests/test_textstats.py); 32 perturbed inputs for the probe
   1 g2: harvested 15 test calls over 6 functions of src.account (tests/test_account.py); 32 perturbed inputs for the probe
   1 g2: arbitrated 3 passers (0 held) in 1 cluster (probe 32 inputs, 3/3 signatures); escape 0.72, max general 0.16; all-overfit signature
   1 g2: arbitrated 2 passers (0 held) in 1 cluster (probe 32 inputs, 2/2 signatures); escape 0.72, max general 0.09; all-overfit signature
   1 g2: all-overfit signature (escape 0.72 ≥ 0.5, max general 0.16 < 0.3); dropping the 3 passers (kept in tried, none is committed); searching on
   1 g2: all-overfit signature (escape 0.72 ≥ 0.5, max general 0.09 < 0.3); dropping the 2 passers (kept in tried, none is committed); searching on with th
   1 g1: site batch shortest_path_length.py:19:insert complete; committing its lone passer mutation/statement_template at shortest_path_length.py:19:insert
   1 g1: refuses the passing candidate tpl_guard_empty_break_before_35119015bb — it adds a path that leaves a function with an implicit `return None`, whil
   1 g1: refuses the passing candidate mutation:statement_template:1089a106 — it mutates in place a parameter the pre-patch code left alone, so the caller'
   1 g1: lone passer mutation/statement_template at src/inventory.py:59:insert looks adds_special_case but general 0.80 ≥ 0.3 keeps it
   1 g1: lone passer mutation/statement_template at src/calendar_utils.py:37:insert looks adds_special_case but general 0.47 ≥ 0.3 keeps it
   1 g1: lone passer mutation/off_by_one_atom at find_in_sorted.py:9:replace looks adds_special_case but general 0.62 ≥ 0.3 keeps it
   1 g1: lone passer llm/sample_0_0 at src/units.py:24:replace looks adds_special_case but general 0.67 ≥ 0.3 keeps it
   1 g1: lone passer llm/sample_0_0 at shortest_path_length.py:19:replace looks duplicates_block but general 0.77 ≥ 0.3 keeps it
   1 g1: lone passer composite/signature_unit:add_param_sibling_with_edits:from_call at src/table.py:43:replace looks adds_special_case but general 0.51 ≥ 
   1 g1: holds the lone passer mutation/statement_template at src/calendar_utils.py:37:insert until its site's seed sources ran
   1 g1: holds the lone passer mutation/statement_template at shortest_path_length.py:19:insert until its site's seed sources ran
   1 g1: holds the lone passer llm/sample_3_0 at sympy/printing/mathematica.py:102:replace as suspect (adds_special_case; general 0.24 < 0.3): never releas
   1 g1: holds the lone passer llm/sample_0_0 at src/hunks.py:31:replace as suspect (deletes_statement, adds_special_case; general 0.10 < 0.3): never relea
   1 g1: holds the lone passer donor/statement_donor at wrap.py:7:insert as suspect (duplicates_block, adds_special_case; general 0.05 < 0.3): never releas
   1 g1: holds the lone passer donor/statement_donor at lis.py:12:insert as suspect (adds_special_case; general 0.27 < 0.3): never released on the budget r
   1 g1: harvested 34 test calls over 18 functions of src.apply, src.hunks, src.merge, src.preview, src.text (tests/test_hunks.py); 32 perturbed inputs for
   1 g1: harvested 22 test calls over 8 functions of src.stats (tests/test_stats.py); 32 perturbed inputs for the probe
   1 g1: harvested 16 test calls over 6 functions of src.profiles (tests/test_profiles.py); 30 perturbed inputs for the probe
   1 g1: arbitrated 4 passers (0 held) in 1 cluster (probe 32 inputs, 4/4 signatures); escape 0.15, max general 0.49; pick template/guard_empty_raise at sr
   1 g1: arbitrated 4 passers (0 held) in 1 cluster (no probe); escape 0.04, max general 0.61; pick llm/sample_0_0 at sympy/simplify/fu.py:504:replace
   1 g1: arbitrated 3 passers (0 held) in 1 cluster (no probe); escape 0.23, max general 0.52; pick llm/sample_3_0 at sympy/combinatorics/perm_groups.py:21
   1 g1: arbitrated 2 passers (1 held) in 2 clusters (probe 16 inputs, 2/2 signatures, 6 differing inputs shown); escape 0.12, max general 0.72; pick mutat
   1 g1: arbitrated 2 passers (1 held) in 1 cluster (probe 32 inputs, 2/2 signatures); escape 0.57, max general 0.21; all-overfit signature
   1 g1: arbitrated 2 passers (0 held) in 1 cluster (no probe); escape 0.21, max general 0.81; pick llm/sample_0_0 at sympy/geometry/point.py:269:replace
   1 g1: all-overfit signature (escape 0.57 ≥ 0.5, max general 0.21 < 0.3); dropping the 2 passers (kept in tried, none is committed); searching on
   1 g1: 4 passers in one behaviour cluster with a code seed and an LLM candidate (probe 16 inputs, 4/4 signatures); committing the LLM member llm/sample_0
   1 g1: 3 passers (0 held) in 2 behaviour clusters (probe 16 inputs, 3/3 signatures; cluster_1 2 members/support 1, cluster_2 1 member/support 1); the clu
   1 g1: 2 passers in one behaviour cluster with a code seed and an LLM candidate (probe 30 inputs, 2/2 signatures); committing the LLM member llm/sample_0
   1 g1: 2 passers in one behaviour cluster with a code seed and an LLM candidate (probe 16 inputs, 2/2 signatures); committing the LLM member llm/sample_1
   1 g1: 2 passers in one behaviour cluster with a code seed and an LLM candidate (probe 16 inputs, 2/2 signatures); committing the LLM member llm/sample_0
   1 g1: 2 passers in one behaviour cluster with a code seed and an LLM candidate (no probe); committing the LLM member llm/sample_3_0 at sympy/printing/ma
   1 g1: 2 passers (1 held) in 2 behaviour clusters (probe 16 inputs, 2/2 signatures; cluster_1 1 member/support 1, cluster_2 1 member/support 1); the clus

# hard refusals of a passing candidate: 2
# adds_implicit_none_exit lines:        1

# goal sizes (synth goal: lines)
 129 (1 test, attempt
   3 (10 tests, attempt
   1 (13 tests, attempt
   7 (2 tests, attempt
   3 (3 tests, attempt
   3 (4 tests, attempt
   5 (5 tests, attempt
   1 (6 tests, attempt
   3 (7 tests, attempt
   1 (9 tests, attempt
```
