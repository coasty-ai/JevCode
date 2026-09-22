# llm-jev head-to-head — llm-jev vs jev-off-tuned

Sources: `oos-glm-jev-off-tuned-quixbugs`, `oos-glm-jev-off-tuned-ladder-long`, `oos-glm-jev-off-tuned-swebench`, `oos-llm-jev-quixbugs`, `oos-llm-jev-ladder-long`, `oos-llm-jev-swebench`. Arms present: llm-jev, jev-off-tuned. Verdict files for: jev-off-tuned, llm-jev. Records: 44.

## Verdict (§10.6)

Failed: quixbugs criterion 1 (pass (discordant pairs)); quixbugs criterion 2 (correct-by-verdict); ladder criterion 1 (pass (discordant pairs)); ladder criterion 2 (correct-by-verdict); ladder criterion 3 (wall (median per task)); ladder criterion 4 (cost ($ per solved, $ per task)); swebench criterion 1 (pass (discordant pairs)); swebench criterion S2 (patchEmpty ≤ baseline). Not evaluable: swebench criterion 3, swebench criterion 4.

### Attribution (criterion 5, secondary)

- criterion 5a — attribution vs llm-sieve: not evaluable (not gating) — no paired llm-sieve records
- criterion 5b — attribution vs jev-off-tuned: reported (not gating) — quixbugs: pass 10 vs 10 of 10, correct 10 vs 10, median wall 0.43×, $ per solved 0.30×; ladder: pass 3 vs 2 of 8, correct 3 vs 2, median wall 3.72×, $ per solved 1.91×; swebench: pass 0 vs 0 of 4, correct 0 vs 0, median wall 1.45×, $ per solved n/a

## QuixBugs Python (40 one-line bugs)

Limits (summary.json): 12 steps / 8 min / $0.06 per task.

#### Arms (all evaluated records of the suite)

| arm | pass | Wilson 95% | correct | overfit | steps-to-solve median | wall median / mean | $ per task | $ per solved | generator calls / valid / length / dropped | est. $ | Jev requests (stubbed) | refused | patchEmpty | drift |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| llm-jev | 10/10 100% | [72%, 100%] | 10 | 0 | 3 (n=10) | 34s / 44s | $0.0008 | $0.0008 | 14 / 8 / 0 / 6 | $0.0002 | 54 | 0 | 0 | 0 |
| jev-off-tuned | 10/10 100% | [72%, 100%] | 10 | 0 | 6 (n=10) | 1m18s / 1m45s | $0.0026 | $0.0026 | 82 / 61 / 0 / 21 | $0.0064 | 0 | 0 | 0 | 0 |

#### Paired vs baseline (tasks evaluated in both, drift excluded)

| arm vs baseline | n | b (arm wins) | c (baseline wins) | both | neither | sign test p | median wall | Wilcoxon p | $ per task | $ per solved | correct |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| llm-jev vs jev-off-tuned | 10 | 0 | 0 | 10 | 0 | n/a | 34s vs 1m18s (0.43×) | 0.010 | 0.30× | 0.30× | 10 vs 10 |

#### Pre-registered criteria (§1.3)

- criterion 1 — pass (discordant pairs): **FAIL** — n = 10: b = 0 (llm-jev wins), c = 0 (jev-off-tuned wins), both 10, neither 0; bar b − c ≥ 8 ∧ c ≤ 2; sign test p n/a
- criterion 2 — correct-by-verdict: **FAIL** — llm-jev 10 vs jev-off-tuned 10 correct of 10 (Δ +0, bar ≥ +8)
- criterion 3 — wall (median per task): **pass** — median 34s vs 1m18s (0.43×, bar ≤ 0.5×); one-sided Wilcoxon signed-rank p = 0.010 over 10 non-tied pairs (bar < 0.05)
- criterion 4 — cost ($ per solved, $ per task): **pass** — $ per solved $0.0008 vs $0.0026 (0.30×, bar ≤ 0.75×); $ per task $0.0008 vs $0.0026 (0.30×, bar ≤ 1×)
- criterion S1 — refused steps (blocked + declined) on the candidate: **pass** — 0 (bar 0)
- criterion S2 — patchEmpty ≤ baseline: **pass** — 0 vs 0
- criterion S3 — zero modelDrift on the candidate: **pass** — 0 record(s) with drift (excluded from the pairs)

#### Per task

| task | llm-jev | steps | wall | $ | jev-off-tuned | steps | wall | $ |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| breadth_first_search | pass | 3 | 34s | $0.0005 | pass | 12 | 3m14s | $0.0038 |
| get_factors | pass | 2 | 31s | $0.0002 | pass | 11 | 2m37s | $0.0036 |
| hanoi | pass | 3 | 39s | $0.0003 | pass | 10 | 2m21s | $0.0029 |
| is_valid_parenthesization | pass | 2 | 19s | $0.0003 | pass | 5 | 1m14s | $0.0014 |
| knapsack | pass | 3 | 1m18s | $0.0009 | pass | 5 | 1m18s | $0.0015 |
| lcs_length | pass | 3 | 1m7s | $0.0010 | pass | 6 | 1m13s | $0.0015 |
| levenshtein | pass | 4 | 1m22s | $0.0026 | pass | 4 | 43s | $0.0008 |
| next_palindrome | pass | 2 | 37s | $0.0007 | pass | 12 | 1m48s | $0.0044 |
| pascal | pass | 3 | 27s | $0.0009 | pass | 12 | 1m57s | $0.0048 |
| powerset | pass | 2 | 30s | $0.0005 | pass | 5 | 1m | $0.0013 |

## Ladder (hand-made multi-hunk tasks)

Limits (summary.json): 30 steps / 15 min / $0.15 per task.

#### Arms (all evaluated records of the suite)

| arm | pass | Wilson 95% | correct | overfit | steps-to-solve median | wall median / mean | $ per task | $ per solved | generator calls / valid / length / dropped | est. $ | Jev requests (stubbed) | refused | patchEmpty | drift |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| llm-jev | 3/8 38% | [14%, 69%] | 3 | 0 | 10 (n=3) | 8m32s / 9m46s | $0.0494 | $0.1318 | 244 / 115 / 0 / 129 | $0.0342 | 1532 | 0 | 2 | 0 |
| jev-off-tuned | 2/8 25% | [7%, 59%] | 2 | 0 | 23 (n=2) | 2m17s / 2m39s | $0.0172 | $0.0690 | 233 / 227 / 0 / 6 | $0.0037 | 0 | 0 | 3 | 0 |

#### Paired vs baseline (tasks evaluated in both, drift excluded)

| arm vs baseline | n | b (arm wins) | c (baseline wins) | both | neither | sign test p | median wall | Wilcoxon p | $ per task | $ per solved | correct |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| llm-jev vs jev-off-tuned | 8 | 2 | 1 | 1 | 4 | 0.500 | 8m32s vs 2m17s (3.72×) | 1.000 | 2.87× | 1.91× | 3 vs 2 |

#### Pre-registered criteria (§1.3)

- criterion 1 — pass (discordant pairs): **FAIL** — n = 8: b = 2 (llm-jev wins), c = 1 (jev-off-tuned wins), both 1, neither 4; bar b − c ≥ 3 ∧ c ≤ 1; no p-value (under-powered by design)
- criterion 2 — correct-by-verdict: **FAIL** — llm-jev 3 vs jev-off-tuned 2 correct of 8 (Δ +1, bar ≥ +2); overfits 0 (bar ≤ 1)
- criterion 3 — wall (median per task): **FAIL** — median 8m32s vs 2m17s (3.72×, bar ≤ 0.5×); one-sided Wilcoxon signed-rank p = 1.000 over 8 non-tied pairs (bar < 0.05)
- criterion 4 — cost ($ per solved, $ per task): **FAIL** — $ per solved $0.1318 vs $0.0690 (1.91×, bar ≤ 0.9×); $ per task $0.0494 vs $0.0172 (2.87×, bar ≤ 1×)
- criterion S1 — refused steps (blocked + declined) on the candidate: **pass** — 0 (bar 0)
- criterion S2 — patchEmpty ≤ baseline: **pass** — 2 vs 3
- criterion S3 — zero modelDrift on the candidate: **pass** — 0 record(s) with drift (excluded from the pairs)

#### Per task

| task | llm-jev | steps | wall | $ | jev-off-tuned | steps | wall | $ |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| crossfile | fail | 20 | 14m52s | $0.1117 | fail | 30 | 2m17s | $0.0196 |
| import_and_guard | pass | 6 | 3m10s | $0.0035 | fail | 30 | 2m17s | $0.0182 |
| ledger5 | pass | 14 | 8m30s | $0.0246 | fail | 30 | 2m16s | $0.0188 |
| long_chain | fail | 23 | 14m10s | $0.0904 | fail | 30 | 1m40s | $0.0182 |
| masked | fail | 12 | 8m32s | $0.0322 | pass | 30 | 2m54s | $0.0167 |
| regress_trap | fail | 14 | 9m5s | $0.0377 | fail | 30 | 3m28s | $0.0168 |
| shared_frame | pass | 10 | 7m29s | $0.0363 | pass | 23 | 2m28s | $0.0123 |
| six_hunks | fail | 12 | 12m21s | $0.0591 | fail | 30 | 3m54s | $0.0173 |

## SWE-bench Verified (local subset)

Limits (summary.json): 25 steps / 25 min / $0.25 per task.

#### Arms (all evaluated records of the suite)

| arm | pass | Wilson 95% | correct | overfit | steps-to-solve median | wall median / mean | $ per task | $ per solved | generator calls / valid / length / dropped | est. $ | Jev requests (stubbed) | refused | patchEmpty | drift |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| llm-jev | 0/4 0% | [0%, 49%] | 0 | 0 | n/a | 5m22s / 12m22s | $0.0971 | n/a | 130 / 58 / 0 / 72 | $0.0420 | 744 | 0 | 3 | 0 |
| jev-off-tuned | 0/4 0% | [0%, 49%] | 0 | 0 | n/a | 3m41s / 4m3s | $0.0330 | n/a | 106 / 97 / 0 / 3 | $0.0038 | 0 | 0 | 2 | 0 |

#### Paired vs baseline (tasks evaluated in both, drift excluded)

| arm vs baseline | n | b (arm wins) | c (baseline wins) | both | neither | sign test p | median wall | Wilcoxon p | $ per task | $ per solved | correct |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| llm-jev vs jev-off-tuned | 4 | 0 | 0 | 0 | 4 | n/a | 5m22s vs 3m41s (1.45×) | 1.000 | 2.94× | n/a | 0 vs 0 |

#### Pre-registered criteria (§1.3)

- criterion 1 — pass (discordant pairs): **FAIL** — n = 4: b = 0 (llm-jev wins), c = 0 (jev-off-tuned wins), both 0, neither 4; bar b − c ≥ 4 ∧ c ≤ 2; sign test p n/a (reported, not gating)
- criterion 2 — correctness: reported (not gating) — SWE: correctness = evaluator pass (criterion 1)
- criterion 3 — wall (tasks solved by both): not evaluable — 0 tasks solved by both: mean wall n/a vs n/a (n/a, bar ≤ 1.0×); mean steps-to-solve n/a vs n/a (n/a, bar ≤ 0.5×)
- criterion 4 — cost ($ per solved, $ per task): not evaluable — $ per solved n/a vs n/a (n/a, bar ≤ 0.75×); $ per task $0.0971 vs $0.0330 (2.94×, bar ≤ 1×)
- criterion S1 — refused steps (blocked + declined) on the candidate: **pass** — 0 (bar 0)
- criterion S2 — patchEmpty ≤ baseline: **FAIL** — 3 vs 2
- criterion S3 — zero modelDrift on the candidate: **pass** — 0 record(s) with drift (excluded from the pairs)

#### Per task

| task | llm-jev | steps | wall | $ | jev-off-tuned | steps | wall | $ |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| sympy__sympy-13798 | fail | 18 | 5m22s | $0.0238 | fail | 25 | 4m18s | $0.0299 |
| sympy__sympy-16792 | fail | 19 | 25m | $0.2178 | fail | 25 | 3m41s | $0.0302 |
| sympy__sympy-20428 | fail | 4 | 4m33s | $0.0215 | fail | 25 | 3m5s | $0.0322 |
| sympy__sympy-22080 | fail | 10 | 14m32s | $0.1254 | fail | 25 | 5m10s | $0.0397 |

