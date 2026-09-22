# llm-jev head-to-head — llm-jev vs jev-off

Sources: `glm-jev-off-samebuild-quixbugs`, `glm-jev-off-samebuild-ladder`, `glm-jev-off-samebuild-swebench`, `llm-jev-v2-quixbugs`, `llm-jev-v2-ladder`, `llm-jev-v2-swebench`. Arms present: jev-off, llm-jev. Verdict files for: jev-off, llm-jev. Records: 56.

## Verdict (§10.6)

Failed: quixbugs criterion 1 (pass (discordant pairs)); quixbugs criterion 2 (correct-by-verdict); quixbugs criterion 3 (wall (median per task)); ladder criterion 1 (pass (discordant pairs)); ladder criterion 2 (correct-by-verdict).

### Attribution (criterion 5, secondary)

- criterion 5a — attribution vs llm-sieve: not evaluable (not gating) — no paired llm-sieve records
- criterion 5b — attribution vs jev-off-tuned: not evaluable (not gating) — no paired jev-off-tuned records

## QuixBugs Python (40 one-line bugs)

Limits (summary.json): 12 steps / 8 min / $0.06 per task.

#### Arms (all evaluated records of the suite)

| arm | pass | Wilson 95% | correct | overfit | steps-to-solve median | wall median / mean | $ per task | $ per solved | generator calls / valid / length / dropped | est. $ | Jev requests (stubbed) | refused | patchEmpty | drift |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| jev-off | 8/10 80% | [49%, 94%] | 8 | 0 | 5 (n=8) | 1m / 3m26s | $0.0066 | $0.0082 | 64 / 51 / 8 / 0 | $0.0000 | 0 | 0 | 2 | 0 |
| llm-jev | 10/10 100% | [72%, 100%] | 9 | 1 | 3 (n=10) | 36s / 1m6s | $0.0026 | $0.0026 | 23 / 9 / 0 / 14 | $0.0023 | 105 | 0 | 0 | 0 |

#### Paired vs baseline (tasks evaluated in both, drift excluded)

| arm vs baseline | n | b (arm wins) | c (baseline wins) | both | neither | sign test p | median wall | Wilcoxon p | $ per task | $ per solved | correct |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| llm-jev vs jev-off | 10 | 2 | 0 | 8 | 0 | 0.250 | 36s vs 1m (0.60×) | 0.010 | 0.40× | 0.32× | 9 vs 8 |

#### Pre-registered criteria (§1.3)

- criterion 1 — pass (discordant pairs): **FAIL** — n = 10: b = 2 (llm-jev wins), c = 0 (jev-off wins), both 8, neither 0; bar b − c ≥ 8 ∧ c ≤ 2; sign test p = 0.250
- criterion 2 — correct-by-verdict: **FAIL** — llm-jev 9 vs jev-off 8 correct of 10 (Δ +1, bar ≥ +8)
- criterion 3 — wall (median per task): **FAIL** — median 36s vs 1m (0.60×, bar ≤ 0.5×); one-sided Wilcoxon signed-rank p = 0.010 over 10 non-tied pairs (bar < 0.05)
- criterion 4 — cost ($ per solved, $ per task): **pass** — $ per solved $0.0026 vs $0.0082 (0.32×, bar ≤ 0.75×); $ per task $0.0026 vs $0.0066 (0.40×, bar ≤ 1×)
- criterion S1 — refused steps (blocked + declined) on the candidate: **pass** — 0 (bar 0)
- criterion S2 — patchEmpty ≤ baseline: **pass** — 0 vs 2
- criterion S3 — zero modelDrift on the candidate: **pass** — 0 record(s) with drift (excluded from the pairs)

#### Per task

| task | jev-off | steps | wall | $ | llm-jev | steps | wall | $ |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| bitcount | pass | 5 | 59s | $0.0023 | pass | 3 | 1m44s | $0.0011 |
| bucketsort | pass | 5 | 52s | $0.0023 | pass | 2 | 33s | $0.0004 |
| detect_cycle | pass | 6 | 2m42s | $0.0066 | pass | 2 | 35s | $0.0004 |
| find_in_sorted | pass | 4 | 52s | $0.0019 | pass | 3 | 36s | $0.0005 |
| gcd | pass | 5 | 58s | $0.0026 | pass | 3 | 16s | $0.0005 |
| kth | pass | 5 | 1m | $0.0019 | pass | 3 | 29s | $0.0007 |
| lis | pass | 4 | 8m | $0.0111 | pass | 3 | 1m36s | $0.0096 |
| mergesort | pass | 7 | 2m55s | $0.0118 | pass | 3 | 1m35s | $0.0056 |
| shortest_path_length | fail | 6 | 8m | $0.0040 | pass | 3 | 2m32s | $0.0068 |
| wrap | fail | 6 | 8m | $0.0211 | pass | 2 | 1m2s | $0.0008 |

## Ladder (hand-made multi-hunk tasks)

Limits (summary.json): 25 steps / 12 min / $0.1 per task.

#### Arms (all evaluated records of the suite)

| arm | pass | Wilson 95% | correct | overfit | steps-to-solve median | wall median / mean | $ per task | $ per solved | generator calls / valid / length / dropped | est. $ | Jev requests (stubbed) | refused | patchEmpty | drift |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| jev-off | 11/12 92% | [65%, 99%] | 10 | 1 | 9 (n=11) | 3m20s / 5m23s | $0.0119 | $0.0130 | 137 / 125 / 1 / 0 | $0.0000 | 0 | 0 | 0 | 0 |
| llm-jev | 12/12 100% | [76%, 100%] | 11 | 1 | 2 (n=12) | 39s / 1m2s | $0.0041 | $0.0041 | 32 / 22 / 0 / 10 | $0.0018 | 203 | 0 | 0 | 0 |

#### Paired vs baseline (tasks evaluated in both, drift excluded)

| arm vs baseline | n | b (arm wins) | c (baseline wins) | both | neither | sign test p | median wall | Wilcoxon p | $ per task | $ per solved | correct |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| llm-jev vs jev-off | 12 | 1 | 0 | 11 | 0 | 0.500 | 39s vs 3m20s (0.20×) | 0.000 | 0.35× | 0.32× | 11 vs 10 |

#### Pre-registered criteria (§1.3)

- criterion 1 — pass (discordant pairs): **FAIL** — n = 12: b = 1 (llm-jev wins), c = 0 (jev-off wins), both 11, neither 0; bar b − c ≥ 3 ∧ c ≤ 1; no p-value (under-powered by design)
- criterion 2 — correct-by-verdict: **FAIL** — llm-jev 11 vs jev-off 10 correct of 12 (Δ +1, bar ≥ +2); overfits 1 (bar ≤ 1)
- criterion 3 — wall (median per task): **pass** — median 39s vs 3m20s (0.20×, bar ≤ 0.5×); one-sided Wilcoxon signed-rank p = 0.000 over 12 non-tied pairs (bar < 0.05)
- criterion 4 — cost ($ per solved, $ per task): **pass** — $ per solved $0.0041 vs $0.0130 (0.32×, bar ≤ 0.9×); $ per task $0.0041 vs $0.0119 (0.35×, bar ≤ 1×)
- criterion S1 — refused steps (blocked + declined) on the candidate: **pass** — 0 (bar 0)
- criterion S2 — patchEmpty ≤ baseline: **pass** — 0 vs 0
- criterion S3 — zero modelDrift on the candidate: **pass** — 0 record(s) with drift (excluded from the pairs)

#### Per task

| task | jev-off | steps | wall | $ | llm-jev | steps | wall | $ |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| account | pass | 15 | 7m36s | $0.0195 | pass | 5 | 3m | $0.0172 |
| calendar_utils | pass | 8 | 2m57s | $0.0079 | pass | 3 | 1m17s | $0.0009 |
| events | pass | 14 | 8m58s | $0.0124 | pass | 2 | 39s | $0.0008 |
| grades | fail | 11 | 12m | $0.0186 | pass | 2 | 31s | $0.0011 |
| inventory | pass | 15 | 11m39s | $0.0276 | pass | 3 | 1m4s | $0.0010 |
| profiles | pass | 9 | 2m38s | $0.0059 | pass | 2 | 14s | $0.0011 |
| shipping | pass | 7 | 2m5s | $0.0048 | pass | 3 | 1m29s | $0.0023 |
| stats | pass | 7 | 2m48s | $0.0029 | pass | 4 | 58s | $0.0007 |
| table | pass | 13 | 5m34s | $0.0129 | pass | 4 | 2m24s | $0.0224 |
| tagcloud | pass | 6 | 56s | $0.0037 | pass | 2 | 5s | $0.0006 |
| textstats | pass | 13 | 4m6s | $0.0149 | pass | 2 | 25s | $0.0010 |
| units | pass | 7 | 3m20s | $0.0116 | pass | 2 | 21s | $0.0008 |

## SWE-bench Verified (local subset)

Limits (summary.json): 25 steps / 25 min / $0.25 per task.

#### Arms (all evaluated records of the suite)

| arm | pass | Wilson 95% | correct | overfit | steps-to-solve median | wall median / mean | $ per task | $ per solved | generator calls / valid / length / dropped | est. $ | Jev requests (stubbed) | refused | patchEmpty | drift |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| jev-off | 2/6 33% | [10%, 70%] | 2 | 0 | 19 (n=2) | 25m / 21m13s | $0.0632 | $0.1897 | 170 / 86 / 6 / 0 | $0.0000 | 0 | 0 | 1 | 0 |
| llm-jev | 6/6 100% | [61%, 100%] | 6 | 0 | 2 (n=6) | 2m13s / 2m1s | $0.0113 | $0.0113 | 45 / 31 / 0 / 14 | $0.0098 | 174 | 0 | 0 | 0 |

#### Paired vs baseline (tasks evaluated in both, drift excluded)

| arm vs baseline | n | b (arm wins) | c (baseline wins) | both | neither | sign test p | median wall | Wilcoxon p | $ per task | $ per solved | correct |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| llm-jev vs jev-off | 6 | 4 | 0 | 2 | 0 | 0.063 | 2m13s vs 25m (0.09×) | 0.016 | 0.18× | 0.06× | 6 vs 2 |

#### Pre-registered criteria (§1.3)

- criterion 1 — pass (discordant pairs): **pass** — n = 6: b = 4 (llm-jev wins), c = 0 (jev-off wins), both 2, neither 0; bar b − c ≥ 4 ∧ c ≤ 2; sign test p = 0.063 (reported, not gating)
- criterion 2 — correctness: reported (not gating) — SWE: correctness = evaluator pass (criterion 1)
- criterion 3 — wall (tasks solved by both): **pass** — 2 tasks solved by both: mean wall 1m19s vs 19m (0.07×, bar ≤ 1.0×); mean steps-to-solve 2.0 vs 19.0 (0.11×, bar ≤ 0.5×)
- criterion 4 — cost ($ per solved, $ per task): **pass** — $ per solved $0.0113 vs $0.1897 (0.06×, bar ≤ 0.75×); $ per task $0.0113 vs $0.0632 (0.18×, bar ≤ 1×)
- criterion S1 — refused steps (blocked + declined) on the candidate: **pass** — 0 (bar 0)
- criterion S2 — patchEmpty ≤ baseline: **pass** — 0 vs 1
- criterion S3 — zero modelDrift on the candidate: **pass** — 0 record(s) with drift (excluded from the pairs)

#### Per task

| task | jev-off | steps | wall | $ | llm-jev | steps | wall | $ |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| django__django-15128 | fail | 21 | 25m | $0.0836 | pass | 6 | 1m56s | $0.0224 |
| django__django-15315 | pass | 19 | 25m | $0.0618 | pass | 2 | 23s | $0.0049 |
| sympy__sympy-11618 | fail | 14 | 14m18s | $0.0459 | pass | 10 | 2m13s | $0.0133 |
| sympy__sympy-15345 | fail | 19 | 25m | $0.0710 | pass | 3 | 3m2s | $0.0127 |
| sympy__sympy-17139 | pass | 19 | 13m1s | $0.0460 | pass | 2 | 2m15s | $0.0064 |
| sympy__sympy-19954 | fail | 15 | 25m | $0.0711 | pass | 2 | 2m17s | $0.0083 |

