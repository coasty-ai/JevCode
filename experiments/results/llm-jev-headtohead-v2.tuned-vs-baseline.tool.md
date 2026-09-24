# llm-jev head-to-head — jev-off-tuned vs jev-off

Sources: `glm-jev-off-quixbugs`, `glm-jev-off-tuned-quixbugs`, `glm-jev-off-ladder`, `glm-jev-off-tuned-ladder`, `glm-jev-off-swebench`, `glm-jev-off-tuned-swebench`. Arms present: jev-off, jev-off-tuned. Verdict files for: jev-off, jev-off-tuned. Records: 56.

## Verdict (§10.6)

Failed: quixbugs criterion 1 (pass (discordant pairs)); quixbugs criterion 2 (correct-by-verdict); ladder criterion 1 (pass (discordant pairs)); ladder criterion 2 (correct-by-verdict); swebench criterion 1 (pass (discordant pairs)); swebench criterion 3 (wall (tasks solved by both)). jev-off-tuned matches llm-jev on pass and correctness: the pass-rate gain is generator hygiene, not Jev.

### Attribution (criterion 5, secondary)

- criterion 5a — attribution vs llm-sieve: not evaluable (not gating) — no paired llm-sieve records
- criterion 5b — attribution vs jev-off-tuned: reported (not gating) — jev-off-tuned MATCHES the candidate on pass and correctness — hygiene alone explains the pass rate. quixbugs: pass 8 vs 8 of 10, correct 8 vs 8, median wall 1.00×, $ per solved 1.00×; ladder: pass 10 vs 10 of 12, correct 8 vs 8, median wall 1.00×, $ per solved 1.00×; swebench: pass 4 vs 4 of 6, correct 4 vs 4, median wall 1.00×, $ per solved 1.00×

## QuixBugs Python (40 one-line bugs)

Limits (summary.json): 12 steps / 8 min / $0.06 per task.

#### Arms (all evaluated records of the suite)

| arm | pass | Wilson 95% | correct | overfit | steps-to-solve median | wall median / mean | $ per task | $ per solved | generator calls / valid / length / dropped | est. $ | Jev requests (stubbed) | refused | patchEmpty | drift |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| jev-off | 7/10 70% | [40%, 89%] | 7 | 0 | 4 (n=7) | 1m33s / 3m58s | $0.0093 | $0.0133 | 74 / 48 / 18 / 0 | $0.0000 | 0 | 0 | 2 | 0 |
| jev-off-tuned | 8/10 80% | [49%, 94%] | 8 | 0 | 5 (n=8) | 33s / 58s | $0.0032 | $0.0040 | 79 / 68 / 0 / 9 | $0.0037 | 0 | 0 | 1 | 0 |

#### Paired vs baseline (tasks evaluated in both, drift excluded)

| arm vs baseline | n | b (arm wins) | c (baseline wins) | both | neither | sign test p | median wall | Wilcoxon p | $ per task | $ per solved | correct |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| jev-off-tuned vs jev-off | 10 | 2 | 1 | 6 | 1 | 0.500 | 33s vs 1m33s (0.36×) | 0.001 | 0.35× | 0.30× | 8 vs 7 |

#### Pre-registered criteria (§1.3)

- criterion 1 — pass (discordant pairs): **FAIL** — n = 10: b = 2 (jev-off-tuned wins), c = 1 (jev-off wins), both 6, neither 1; bar b − c ≥ 8 ∧ c ≤ 2; sign test p = 0.500
- criterion 2 — correct-by-verdict: **FAIL** — jev-off-tuned 8 vs jev-off 7 correct of 10 (Δ +1, bar ≥ +8)
- criterion 3 — wall (median per task): **pass** — median 33s vs 1m33s (0.36×, bar ≤ 0.5×); one-sided Wilcoxon signed-rank p = 0.001 over 10 non-tied pairs (bar < 0.05)
- criterion 4 — cost ($ per solved, $ per task): **pass** — $ per solved $0.0040 vs $0.0133 (0.30×, bar ≤ 0.75×); $ per task $0.0032 vs $0.0093 (0.35×, bar ≤ 1×)
- criterion S1 — refused steps (blocked + declined) on the candidate: **pass** — 0 (bar 0)
- criterion S2 — patchEmpty ≤ baseline: **pass** — 1 vs 2
- criterion S3 — zero modelDrift on the candidate: **pass** — 0 record(s) with drift (excluded from the pairs)

#### Per task

| task | jev-off | steps | wall | $ | jev-off-tuned | steps | wall | $ |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| bitcount | pass | 4 | 1m33s | $0.0049 | pass | 5 | 31s | $0.0017 |
| bucketsort | pass | 5 | 1m6s | $0.0019 | pass | 5 | 31s | $0.0017 |
| detect_cycle | pass | 4 | 8m | $0.0077 | pass | 6 | 41s | $0.0017 |
| find_in_sorted | pass | 4 | 1m19s | $0.0041 | pass | 6 | 1m9s | $0.0018 |
| gcd | pass | 4 | 53s | $0.0026 | pass | 5 | 14s | $0.0017 |
| kth | pass | 5 | 20s | $0.0023 | pass | 5 | 19s | $0.0015 |
| lis | pass | 6 | 2m34s | $0.0116 | fail | 9 | 2m13s | $0.0061 |
| mergesort | fail | 4 | 8m | $0.0070 | pass | 12 | 33s | $0.0061 |
| shortest_path_length | fail | 8 | 8m | $0.0279 | pass | 12 | 1m41s | $0.0051 |
| wrap | fail | 10 | 8m | $0.0230 | fail | 12 | 1m51s | $0.0049 |

## Ladder (hand-made multi-hunk tasks)

Limits (summary.json): 25 steps / 12 min / $0.1 per task.

#### Arms (all evaluated records of the suite)

| arm | pass | Wilson 95% | correct | overfit | steps-to-solve median | wall median / mean | $ per task | $ per solved | generator calls / valid / length / dropped | est. $ | Jev requests (stubbed) | refused | patchEmpty | drift |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| jev-off | 9/12 75% | [47%, 91%] | 9 | 0 | 9 (n=9) | 4m49s / 5m42s | $0.0116 | $0.0155 | 176 / 154 / 16 / 0 | $0.0000 | 0 | 0 | 0 | 0 |
| jev-off-tuned | 10/12 83% | [55%, 95%] | 8 | 2 | 13 (n=10) | 1m54s / 2m6s | $0.0072 | $0.0086 | 199 / 168 / 0 / 21 | $0.0091 | 0 | 0 | 0 | 0 |

#### Paired vs baseline (tasks evaluated in both, drift excluded)

| arm vs baseline | n | b (arm wins) | c (baseline wins) | both | neither | sign test p | median wall | Wilcoxon p | $ per task | $ per solved | correct |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| jev-off-tuned vs jev-off | 12 | 2 | 1 | 8 | 1 | 0.500 | 1m54s vs 4m49s (0.40×) | 0.002 | 0.62× | 0.56× | 8 vs 9 |

#### Pre-registered criteria (§1.3)

- criterion 1 — pass (discordant pairs): **FAIL** — n = 12: b = 2 (jev-off-tuned wins), c = 1 (jev-off wins), both 8, neither 1; bar b − c ≥ 3 ∧ c ≤ 1; no p-value (under-powered by design)
- criterion 2 — correct-by-verdict: **FAIL** — jev-off-tuned 8 vs jev-off 9 correct of 12 (Δ -1, bar ≥ +2); overfits 2 (bar ≤ 1)
- criterion 3 — wall (median per task): **pass** — median 1m54s vs 4m49s (0.40×, bar ≤ 0.5×); one-sided Wilcoxon signed-rank p = 0.002 over 12 non-tied pairs (bar < 0.05)
- criterion 4 — cost ($ per solved, $ per task): **pass** — $ per solved $0.0086 vs $0.0155 (0.56×, bar ≤ 0.9×); $ per task $0.0072 vs $0.0116 (0.62×, bar ≤ 1×)
- criterion S1 — refused steps (blocked + declined) on the candidate: **pass** — 0 (bar 0)
- criterion S2 — patchEmpty ≤ baseline: **pass** — 0 vs 0
- criterion S3 — zero modelDrift on the candidate: **pass** — 0 record(s) with drift (excluded from the pairs)

#### Per task

| task | jev-off | steps | wall | $ | jev-off-tuned | steps | wall | $ |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| account | fail | 25 | 9m59s | $0.0285 | fail | 25 | 2m42s | $0.0133 |
| calendar_utils | fail | 20 | 12m | $0.0194 | pass | 14 | 1m32s | $0.0066 |
| events | pass | 8 | 1m48s | $0.0050 | pass | 13 | 1m45s | $0.0052 |
| grades | pass | 17 | 5m19s | $0.0181 | pass | 16 | 2m26s | $0.0065 |
| inventory | pass | 22 | 10m33s | $0.0285 | pass | 21 | 2m22s | $0.0100 |
| profiles | pass | 10 | 1m51s | $0.0063 | pass | 13 | 1m54s | $0.0050 |
| shipping | pass | 9 | 1m35s | $0.0038 | pass | 8 | 55s | $0.0028 |
| stats | pass | 6 | 47s | $0.0024 | pass | 6 | 27s | $0.0016 |
| table | fail | 10 | 12m | $0.0085 | pass | 24 | 3m47s | $0.0128 |
| tagcloud | pass | 6 | 1m14s | $0.0020 | pass | 9 | 1m29s | $0.0032 |
| textstats | pass | 14 | 4m49s | $0.0088 | fail | 25 | 3m47s | $0.0110 |
| units | pass | 9 | 6m30s | $0.0081 | pass | 17 | 2m7s | $0.0083 |

## SWE-bench Verified (local subset)

Limits (summary.json): 25 steps / 25 min / $0.25 per task.

#### Arms (all evaluated records of the suite)

| arm | pass | Wilson 95% | correct | overfit | steps-to-solve median | wall median / mean | $ per task | $ per solved | generator calls / valid / length / dropped | est. $ | Jev requests (stubbed) | refused | patchEmpty | drift |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| jev-off | 3/6 50% | [19%, 81%] | 3 | 0 | 14 (n=3) | 25m / 19m18s | $0.0457 | $0.0913 | 133 / 79 / 39 / 0 | $0.0000 | 0 | 0 | 2 | 0 |
| jev-off-tuned | 4/6 67% | [30%, 90%] | 4 | 0 | 13 (n=4) | 3m2s / 4m8s | $0.0207 | $0.0310 | 123 / 98 / 0 / 16 | $0.0147 | 0 | 0 | 2 | 0 |

#### Paired vs baseline (tasks evaluated in both, drift excluded)

| arm vs baseline | n | b (arm wins) | c (baseline wins) | both | neither | sign test p | median wall | Wilcoxon p | $ per task | $ per solved | correct |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| jev-off-tuned vs jev-off | 6 | 1 | 0 | 3 | 2 | 0.500 | 3m2s vs 25m (0.12×) | 0.016 | 0.45× | 0.34× | 4 vs 3 |

#### Pre-registered criteria (§1.3)

- criterion 1 — pass (discordant pairs): **FAIL** — n = 6: b = 1 (jev-off-tuned wins), c = 0 (jev-off wins), both 3, neither 2; bar b − c ≥ 4 ∧ c ≤ 2; sign test p = 0.500 (reported, not gating)
- criterion 2 — correctness: reported (not gating) — SWE: correctness = evaluator pass (criterion 1)
- criterion 3 — wall (tasks solved by both): **FAIL** — 3 tasks solved by both: mean wall 3m43s vs 18m51s (0.20×, bar ≤ 1.0×); mean steps-to-solve 17.0 vs 17.0 (1.00×, bar ≤ 0.5×)
- criterion 4 — cost ($ per solved, $ per task): **pass** — $ per solved $0.0310 vs $0.0913 (0.34×, bar ≤ 0.75×); $ per task $0.0207 vs $0.0457 (0.45×, bar ≤ 1×)
- criterion S1 — refused steps (blocked + declined) on the candidate: **pass** — 0 (bar 0)
- criterion S2 — patchEmpty ≤ baseline: **pass** — 2 vs 2
- criterion S3 — zero modelDrift on the candidate: **pass** — 0 record(s) with drift (excluded from the pairs)

#### Per task

| task | jev-off | steps | wall | $ | jev-off-tuned | steps | wall | $ |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| django__django-15128 | fail | 23 | 25m | $0.0663 | fail | 25 | 7m18s | $0.0238 |
| django__django-15315 | pass | 24 | 25m | $0.0783 | pass | 11 | 3m2s | $0.0096 |
| sympy__sympy-11618 | pass | 14 | 6m33s | $0.0283 | pass | 25 | 5m26s | $0.0298 |
| sympy__sympy-15345 | fail | 6 | 9m19s | $0.0225 | pass | 13 | 1m52s | $0.0133 |
| sympy__sympy-17139 | pass | 13 | 25m | $0.0419 | pass | 15 | 2m41s | $0.0177 |
| sympy__sympy-19954 | fail | 13 | 25m | $0.0366 | fail | 25 | 4m27s | $0.0297 |

