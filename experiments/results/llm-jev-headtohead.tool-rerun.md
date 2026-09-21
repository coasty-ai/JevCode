# llm-jev head-to-head — llm-jev vs jev-off

Sources: `glm-jev-off-quixbugs`, `llm-jev-quixbugs`, `glm-jev-off-ladder`, `llm-jev-ladder`, `glm-jev-off-swebench`, `llm-jev-swebench`, `llm-jev-swebench-rerun`. Arms present: jev-off, llm-jev. Verdict files for: jev-off, llm-jev. Records: 56.

## Verdict (§10.6)

Failed: quixbugs criterion 1 (pass (discordant pairs)); quixbugs criterion 2 (correct-by-verdict); ladder criterion 2 (correct-by-verdict); swebench criterion 1 (pass (discordant pairs)); swebench criterion 4 (cost ($ per solved, $ per task)).

### Attribution (criterion 5, secondary)

- criterion 5a — attribution vs llm-sieve: not evaluable (not gating) — no paired llm-sieve records
- criterion 5b — attribution vs jev-off-tuned: not evaluable (not gating) — no paired jev-off-tuned records

## QuixBugs Python (40 one-line bugs)

Limits (summary.json): 12 steps / 8 min / $0.06 per task.

#### Arms (all evaluated records of the suite)

| arm | pass | Wilson 95% | correct | overfit | steps-to-solve median | wall median / mean | $ per task | $ per solved | generator calls / valid / length / dropped | est. $ | Jev requests (stubbed) | refused | patchEmpty | drift |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| jev-off | 7/10 70% | [40%, 89%] | 7 | 0 | 4 (n=7) | 1m33s / 3m58s | $0.0093 | $0.0133 | 74 / 48 / 18 / 0 | $0.0000 | 0 | 0 | 2 | 0 |
| llm-jev | 10/10 100% | [72%, 100%] | 8 | 2 | 3 (n=10) | 33s / 1m13s | $0.0027 | $0.0027 | 22 / 16 / 0 / 6 | $0.0006 | 106 | 0 | 0 | 0 |

#### Paired vs baseline (tasks evaluated in both, drift excluded)

| arm vs baseline | n | b (arm wins) | c (baseline wins) | both | neither | sign test p | median wall | Wilcoxon p | $ per task | $ per solved | correct |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| llm-jev vs jev-off | 10 | 3 | 0 | 7 | 0 | 0.125 | 33s vs 1m33s (0.36×) | 0.003 | 0.29× | 0.20× | 8 vs 7 |

#### Pre-registered criteria (§1.3)

- criterion 1 — pass (discordant pairs): **FAIL** — n = 10: b = 3 (llm-jev wins), c = 0 (jev-off wins), both 7, neither 0; bar b − c ≥ 8 ∧ c ≤ 2; sign test p = 0.125
- criterion 2 — correct-by-verdict: **FAIL** — llm-jev 8 vs jev-off 7 correct of 10 (Δ +1, bar ≥ +8)
- criterion 3 — wall (median per task): **pass** — median 33s vs 1m33s (0.36×, bar ≤ 0.5×); one-sided Wilcoxon signed-rank p = 0.003 over 10 non-tied pairs (bar < 0.05)
- criterion 4 — cost ($ per solved, $ per task): **pass** — $ per solved $0.0027 vs $0.0133 (0.20×, bar ≤ 0.75×); $ per task $0.0027 vs $0.0093 (0.29×, bar ≤ 1×)
- criterion S1 — refused steps (blocked + declined) on the candidate: **pass** — 0 (bar 0)
- criterion S2 — patchEmpty ≤ baseline: **pass** — 0 vs 2
- criterion S3 — zero modelDrift on the candidate: **pass** — 0 record(s) with drift (excluded from the pairs)

#### Per task

| task | jev-off | steps | wall | $ | llm-jev | steps | wall | $ |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| bitcount | pass | 4 | 1m33s | $0.0049 | pass | 3 | 1m31s | $0.0011 |
| bucketsort | pass | 5 | 1m6s | $0.0019 | pass | 2 | 30s | $0.0004 |
| detect_cycle | pass | 4 | 8m | $0.0077 | pass | 3 | 33s | $0.0005 |
| find_in_sorted | pass | 4 | 1m19s | $0.0041 | pass | 2 | 26s | $0.0004 |
| gcd | pass | 4 | 53s | $0.0026 | pass | 3 | 15s | $0.0005 |
| kth | pass | 5 | 20s | $0.0023 | pass | 3 | 32s | $0.0007 |
| lis | pass | 6 | 2m34s | $0.0116 | pass | 3 | 1m33s | $0.0023 |
| mergesort | fail | 4 | 8m | $0.0070 | pass | 3 | 2m58s | $0.0140 |
| shortest_path_length | fail | 8 | 8m | $0.0279 | pass | 3 | 2m49s | $0.0055 |
| wrap | fail | 10 | 8m | $0.0230 | pass | 2 | 1m3s | $0.0014 |

## Ladder (hand-made multi-hunk tasks)

Limits (summary.json): 25 steps / 12 min / $0.1 per task.

#### Arms (all evaluated records of the suite)

| arm | pass | Wilson 95% | correct | overfit | steps-to-solve median | wall median / mean | $ per task | $ per solved | generator calls / valid / length / dropped | est. $ | Jev requests (stubbed) | refused | patchEmpty | drift |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| jev-off | 9/12 75% | [47%, 91%] | 9 | 0 | 9 (n=9) | 4m49s / 5m42s | $0.0116 | $0.0155 | 176 / 154 / 16 / 0 | $0.0000 | 0 | 0 | 0 | 0 |
| llm-jev | 12/12 100% | [76%, 100%] | 9 | 3 | 2 (n=12) | 47s / 1m16s | $0.0044 | $0.0044 | 30 / 13 / 0 / 17 | $0.0028 | 230 | 0 | 0 | 0 |

#### Paired vs baseline (tasks evaluated in both, drift excluded)

| arm vs baseline | n | b (arm wins) | c (baseline wins) | both | neither | sign test p | median wall | Wilcoxon p | $ per task | $ per solved | correct |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| llm-jev vs jev-off | 12 | 3 | 0 | 9 | 0 | 0.125 | 47s vs 4m49s (0.16×) | 0.000 | 0.38× | 0.29× | 9 vs 9 |

#### Pre-registered criteria (§1.3)

- criterion 1 — pass (discordant pairs): **pass** — n = 12: b = 3 (llm-jev wins), c = 0 (jev-off wins), both 9, neither 0; bar b − c ≥ 3 ∧ c ≤ 1; no p-value (under-powered by design)
- criterion 2 — correct-by-verdict: **FAIL** — llm-jev 9 vs jev-off 9 correct of 12 (Δ +0, bar ≥ +2); overfits 3 (bar ≤ 1)
- criterion 3 — wall (median per task): **pass** — median 47s vs 4m49s (0.16×, bar ≤ 0.5×); one-sided Wilcoxon signed-rank p = 0.000 over 12 non-tied pairs (bar < 0.05)
- criterion 4 — cost ($ per solved, $ per task): **pass** — $ per solved $0.0044 vs $0.0155 (0.29×, bar ≤ 0.9×); $ per task $0.0044 vs $0.0116 (0.38×, bar ≤ 1×)
- criterion S1 — refused steps (blocked + declined) on the candidate: **pass** — 0 (bar 0)
- criterion S2 — patchEmpty ≤ baseline: **pass** — 0 vs 0
- criterion S3 — zero modelDrift on the candidate: **pass** — 0 record(s) with drift (excluded from the pairs)

#### Per task

| task | jev-off | steps | wall | $ | llm-jev | steps | wall | $ |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| account | fail | 25 | 9m59s | $0.0285 | pass | 5 | 2m55s | $0.0171 |
| calendar_utils | fail | 20 | 12m | $0.0194 | pass | 6 | 2m43s | $0.0034 |
| events | pass | 8 | 1m48s | $0.0050 | pass | 2 | 47s | $0.0011 |
| grades | pass | 17 | 5m19s | $0.0181 | pass | 2 | 24s | $0.0011 |
| inventory | pass | 22 | 10m33s | $0.0285 | pass | 4 | 1m21s | $0.0019 |
| profiles | pass | 10 | 1m51s | $0.0063 | pass | 2 | 19s | $0.0007 |
| shipping | pass | 9 | 1m35s | $0.0038 | pass | 3 | 1m20s | $0.0016 |
| stats | pass | 6 | 47s | $0.0024 | pass | 2 | 20s | $0.0014 |
| table | fail | 10 | 12m | $0.0085 | pass | 4 | 3m6s | $0.0220 |
| tagcloud | pass | 6 | 1m14s | $0.0020 | pass | 2 | 11s | $0.0005 |
| textstats | pass | 14 | 4m49s | $0.0088 | pass | 4 | 1m29s | $0.0018 |
| units | pass | 9 | 6m30s | $0.0081 | pass | 2 | 21s | $0.0008 |

## SWE-bench Verified (local subset)

Limits (summary.json): 25 steps / 25 min / $0.25 per task.

#### Arms (all evaluated records of the suite)

| arm | pass | Wilson 95% | correct | overfit | steps-to-solve median | wall median / mean | $ per task | $ per solved | generator calls / valid / length / dropped | est. $ | Jev requests (stubbed) | refused | patchEmpty | drift |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| jev-off | 3/6 50% | [19%, 81%] | 3 | 0 | 14 (n=3) | 25m / 19m18s | $0.0457 | $0.0913 | 133 / 79 / 39 / 0 | $0.0000 | 0 | 0 | 2 | 0 |
| llm-jev | 1/6 17% | [3%, 56%] | 1 | 0 | 3 (n=1) | 2m37s / 4m14s | $0.0371 | $0.2223 | 22 / 16 / 0 / 6 | $0.0018 | 502 | 0 | 2 | 0 |

#### Paired vs baseline (tasks evaluated in both, drift excluded)

| arm vs baseline | n | b (arm wins) | c (baseline wins) | both | neither | sign test p | median wall | Wilcoxon p | $ per task | $ per solved | correct |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| llm-jev vs jev-off | 6 | 0 | 2 | 1 | 3 | 1.000 | 2m37s vs 25m (0.10×) | 0.016 | 0.81× | 2.43× | 1 vs 3 |

#### Pre-registered criteria (§1.3)

- criterion 1 — pass (discordant pairs): **FAIL** — n = 6: b = 0 (llm-jev wins), c = 2 (jev-off wins), both 1, neither 3; bar b − c ≥ 4 ∧ c ≤ 2; sign test p = 1.000 (reported, not gating)
- criterion 2 — correctness: reported (not gating) — SWE: correctness = evaluator pass (criterion 1)
- criterion 3 — wall (tasks solved by both): **pass** — 1 tasks solved by both: mean wall 6m2s vs 25m (0.24×, bar ≤ 1.0×); mean steps-to-solve 3.0 vs 13.0 (0.23×, bar ≤ 0.5×)
- criterion 4 — cost ($ per solved, $ per task): **FAIL** — $ per solved $0.2223 vs $0.0913 (2.43×, bar ≤ 0.75×); $ per task $0.0371 vs $0.0457 (0.81×, bar ≤ 1×)
- criterion S1 — refused steps (blocked + declined) on the candidate: **pass** — 0 (bar 0)
- criterion S2 — patchEmpty ≤ baseline: **pass** — 2 vs 2
- criterion S3 — zero modelDrift on the candidate: **pass** — 0 record(s) with drift (excluded from the pairs)

#### Per task

| task | jev-off | steps | wall | $ | llm-jev | steps | wall | $ |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| django__django-15128 | fail | 23 | 25m | $0.0663 | fail | 14 | 7m31s | $0.0656 |
| django__django-15315 | pass | 24 | 25m | $0.0783 | fail | 2 | 48s | $0.0060 |
| sympy__sympy-11618 | pass | 14 | 6m33s | $0.0283 | fail | 9 | 6m31s | $0.0837 |
| sympy__sympy-15345 | fail | 6 | 9m19s | $0.0225 | fail | 2 | 2m37s | $0.0041 |
| sympy__sympy-17139 | pass | 13 | 25m | $0.0419 | pass | 3 | 6m2s | $0.0493 |
| sympy__sympy-19954 | fail | 13 | 25m | $0.0366 | fail | 7 | 1m53s | $0.0137 |

