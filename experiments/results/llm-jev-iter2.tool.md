# llm-jev iteration 2 — script outputs (2026-09-22)

Companion to `experiments/results/llm-jev-iter2.md`. Everything below is verbatim tool output, filtered only for
secrets (`grep -vE 'sk-|api[_-]?key'`; nothing matched). Total spend **$1.0413** of a $4 cap. Build `d86c385`, jevcode 0.5.0, worktree
`.claude/worktrees/iter2-clean`, branch `bench-iter2`. `hw.ncpu` = 15.

**Read the loadavg columns.** The machine was shared with a peer session and other agents for the whole window;
`vm.loadavg` ran between 2.9 and 175 on 15 cores. Every per-record `loadavg[0]` is printed beside its wall. Only
§0 (the back-to-back triple) is a load-matched wall comparison; every other wall number is reported with its load
and is not a controlled measurement.

## 0. The warm A/B at matched load — the back-to-back QuixBugs triple (C6)

Three arms over the same 8 fresh QuixBugs tasks, run consecutively in one low-load window
(17:46:41 Z – 17:53:18 Z), same flags, `--concurrency 4 --max-steps 12 --max-wall 8m`:

| task | warm off | load | warm on | load | tuned | load | on/off | off/tuned |
|---|---|---|---|---|---|---|---|---|
| quicksort | pass 26.2 s | 4.6 | pass 22.0 s | 34.9 | pass 11.9 s | 5.3 | 0.84× | 2.20× |
| rpn_eval | pass 26.4 s | 4.6 | pass 20.8 s | 34.9 | pass 51.0 s | 5.3 | 0.79× | 0.52× |
| shortest_path_lengths | pass 28.7 s | 4.6 | pass 22.0 s | 34.9 | pass 67.1 s | 5.3 | 0.77× | 0.43× |
| shortest_paths | pass 39.0 s | 4.6 | pass 23.5 s | 34.9 | pass 18.5 s | 5.3 | 0.60× | 2.11× |
| sieve | pass 27.7 s | 19.7 | pass 17.6 s | 37.1 | pass 23.4 s | 4.7 | 0.63× | 1.18× |
| subsequences | pass 27.3 s | 19.7 | pass 19.1 s | 37.1 | pass 20.3 s | 4.6 | 0.70× | 1.34× |
| to_base | pass 32.6 s | 19.7 | pass 29.7 s | 37.1 | pass 28.5 s | 4.1 | 0.91× | 1.14× |
| topological_ordering | pass 42.6 s | 27.6 | **fail** 210.1 s | 35.2 | pass 40.2 s | 4.1 | 4.93× | 1.06× |

warm off: pass 8/8, median wall 28.2 s, $ 0.005230, median loadavg1 12.2
warm on: pass 7/8, median wall 22.0 s, $ 0.019077, median loadavg1 35.0
jev-off-tuned: pass 8/8, median wall 26.0 s, $ 0.018886, median loadavg1 5.0

warm on/off on the 7 both solved: min 0.602 · median 0.767 · max 0.911; warm on faster on 7/7
llm-jev(warm off)/jev-off-tuned on the 8 both solved: min 0.427 · median 1.163 · max 2.204; llm-jev slower on 6/8

S0 timeline buckets over the 7 tasks both llm-jev arms solve (Σ ms from the archived `state.json.gz` `timing`):

```
warm off  (n=7 both-solved) total   207.8s | synth  97.7% gen  21.8% jev  2.1% exec 1.2% harness 0.47% | synth−(gen+jev+exec) 72.5%
warm on   (n=7 both-solved) total   154.6s | synth  97.0% gen  21.0% jev  2.9% exec 1.4% harness 0.50% | synth−(gen+jev+exec) 71.7%
```

`jevWallMs` is declared on the engine's step timing (`src/loop/engine.ts:440`) but is **not persisted** to
`state.json` or to `steps.jsonl`, so it cannot be read back from an archived record; `timing.jevMs` is what the
records carry and is what is reported above.

## 1. Fresh slice head-to-head — `experiments/llm-jev/headtohead.mts`

Candidate = the iteration-2 `llm-jev` fresh dirs (C1, `JEVCODE_WARM=off`); baseline = the **iteration-2**
`jev-off-tuned` QuixBugs control (C3, same session) plus the **recorded iteration-1** `jev-off-tuned` ladder
and SWE dirs (not re-run — disclosed in the report §1).

```
# llm-jev head-to-head — llm-jev vs jev-off-tuned

Sources: `iter1-fresh-jev-off-tuned-quixbugs`, `iter1-fresh-jev-off-tuned-ladder-long2`, `iter1-fresh-jev-off-tuned-swebench`, `iter2-fresh-jev-off-tuned-quixbugs`, `iter2-fresh-llm-jev-quixbugs`, `iter2-fresh-llm-jev-ladder-long2`, `iter2-fresh-llm-jev-swebench`. Arms present: llm-jev, jev-off-tuned. Verdict files for: jev-off-tuned, llm-jev. Records: 36.

## Verdict (§10.6)

Failed: quixbugs criterion 1 (pass (discordant pairs)); quixbugs criterion 2 (correct-by-verdict); quixbugs criterion 3 (wall (median per task)); ladder criterion 3 (wall (median per task)); swebench criterion 1 (pass (discordant pairs)); swebench criterion 3 (wall (tasks solved by both)). Not evaluable: ladder criterion 4.

### Attribution (criterion 5, secondary)

- criterion 5a — attribution vs llm-sieve: not evaluable (not gating) — no paired llm-sieve records
- criterion 5b — attribution vs jev-off-tuned: reported (not gating) — quixbugs: pass 8 vs 8 of 8, correct 8 vs 8, median wall 2.21×, $ per solved 0.28×; ladder: pass 4 vs 0 of 6, correct 3 vs 0, median wall 2.89×, $ per solved n/a; swebench: pass 2 vs 1 of 3, correct 2 vs 1, median wall 1.29×, $ per solved 0.32×

## QuixBugs Python (40 one-line bugs)

Limits (summary.json): 12 steps / 8 min / $0.06 per task.

#### Arms (all evaluated records of the suite)

| arm | pass | Wilson 95% | correct | overfit | steps-to-solve median | wall median / mean | $ per task | $ per solved | generator calls / valid / length / dropped | est. $ | Jev requests (stubbed) | refused | patchEmpty | drift |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| llm-jev | 8/8 100% | [68%, 100%] | 8 | 0 | 3 (n=8) | 26s / 30s | $0.0007 | $0.0007 | 10 / 8 / 0 / 2 | $0.0003 | 35 | 0 | 0 | 0 |
| jev-off-tuned | 8/8 100% | [68%, 100%] | 8 | 0 | 5 (n=8) | 12s / 20s | $0.0024 | $0.0024 | 51 / 50 / 0 / 0 | $0.0000 | 0 | 0 | 0 | 0 |

#### Paired vs baseline (tasks evaluated in both, drift excluded)

| arm vs baseline | n | b (arm wins) | c (baseline wins) | both | neither | sign test p | median wall | Wilcoxon p | $ per task | $ per solved | correct |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| llm-jev vs jev-off-tuned | 8 | 0 | 0 | 8 | 0 | n/a | 26s vs 12s (2.21×) | 0.973 | 0.28× | 0.28× | 8 vs 8 |

#### Pre-registered criteria (§1.3)

- criterion 1 — pass (discordant pairs): **FAIL** — n = 8: b = 0 (llm-jev wins), c = 0 (jev-off-tuned wins), both 8, neither 0; bar b − c ≥ 8 ∧ c ≤ 2; sign test p n/a
- criterion 2 — correct-by-verdict: **FAIL** — llm-jev 8 vs jev-off-tuned 8 correct of 8 (Δ +0, bar ≥ +8)
- criterion 3 — wall (median per task): **FAIL** — median 26s vs 12s (2.21×, bar ≤ 0.5×); one-sided Wilcoxon signed-rank p = 0.973 over 8 non-tied pairs (bar < 0.05)
- criterion 4 — cost ($ per solved, $ per task): **pass** — $ per solved $0.0007 vs $0.0024 (0.28×, bar ≤ 0.75×); $ per task $0.0007 vs $0.0024 (0.28×, bar ≤ 1×)
- criterion S1 — refused steps (blocked + declined) on the candidate: **pass** — 0 (bar 0)
- criterion S2 — patchEmpty ≤ baseline: **pass** — 0 vs 0
- criterion S3 — zero modelDrift on the candidate: **pass** — 0 record(s) with drift (excluded from the pairs)

#### Per task

| task | llm-jev | steps | wall | $ | jev-off-tuned | steps | wall | $ |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| quicksort | pass | 2 | 25s | $0.0007 | pass | 4 | 10s | $0.0014 |
| rpn_eval | pass | 2 | 25s | $0.0008 | pass | 7 | 39s | $0.0027 |
| shortest_path_lengths | pass | 3 | 27s | $0.0007 | pass | 5 | 9s | $0.0018 |
| shortest_paths | pass | 3 | 35s | $0.0007 | pass | 5 | 12s | $0.0018 |
| sieve | pass | 3 | 26s | $0.0005 | pass | 4 | 9s | $0.0014 |
| subsequences | pass | 3 | 26s | $0.0006 | pass | 11 | 39s | $0.0052 |
| to_base | pass | 3 | 31s | $0.0004 | pass | 10 | 30s | $0.0038 |
| topological_ordering | pass | 2 | 45s | $0.0012 | pass | 4 | 13s | $0.0012 |

## Ladder (hand-made multi-hunk tasks)

Limits (summary.json): 30 steps / 15 min / $0.18 per task.

#### Arms (all evaluated records of the suite)

| arm | pass | Wilson 95% | correct | overfit | steps-to-solve median | wall median / mean | $ per task | $ per solved | generator calls / valid / length / dropped | est. $ | Jev requests (stubbed) | refused | patchEmpty | drift |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| llm-jev | 4/6 67% | [30%, 90%] | 3 | 1 | 3 (n=4) | 6m8s / 7m40s | $0.0256 | $0.0383 | 171 / 94 / 0 / 77 | $0.0246 | 664 | 0 | 1 | 0 |
| jev-off-tuned | 0/6 0% | [0%, 39%] | 0 | 0 | n/a | 2m7s / 2m19s | $0.0185 | n/a | 182 / 171 / 0 / 9 | $0.0054 | 0 | 0 | 4 | 0 |

#### Paired vs baseline (tasks evaluated in both, drift excluded)

| arm vs baseline | n | b (arm wins) | c (baseline wins) | both | neither | sign test p | median wall | Wilcoxon p | $ per task | $ per solved | correct |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| llm-jev vs jev-off-tuned | 6 | 4 | 0 | 0 | 2 | 0.063 | 6m8s vs 2m7s (2.89×) | 0.969 | 1.38× | n/a | 3 vs 0 |

#### Pre-registered criteria (§1.3)

- criterion 1 — pass (discordant pairs): **pass** — n = 6: b = 4 (llm-jev wins), c = 0 (jev-off-tuned wins), both 0, neither 2; bar b − c ≥ 3 ∧ c ≤ 1; no p-value (under-powered by design)
- criterion 2 — correct-by-verdict: **pass** — llm-jev 3 vs jev-off-tuned 0 correct of 6 (Δ +3, bar ≥ +2); overfits 1 (bar ≤ 1)
- criterion 3 — wall (median per task): **FAIL** — median 6m8s vs 2m7s (2.89×, bar ≤ 0.5×); one-sided Wilcoxon signed-rank p = 0.969 over 6 non-tied pairs (bar < 0.05)
- criterion 4 — cost ($ per solved, $ per task): not evaluable — $ per solved $0.0383 vs n/a (n/a, bar ≤ 0.9×); $ per task $0.0256 vs $0.0185 (1.38×, bar ≤ 1×)
- criterion S1 — refused steps (blocked + declined) on the candidate: **pass** — 0 (bar 0)
- criterion S2 — patchEmpty ≤ baseline: **pass** — 1 vs 4
- criterion S3 — zero modelDrift on the candidate: **pass** — 0 record(s) with drift (excluded from the pairs)

#### Per task

| task | llm-jev | steps | wall | $ | jev-off-tuned | steps | wall | $ |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| csv_schema | pass | 8 | 7m12s | $0.0219 | fail | 30 | 2m4s | $0.0195 |
| deadline_queue | pass | 3 | 2m19s | $0.0107 | fail | 30 | 2m53s | $0.0190 |
| dep_order | pass | 3 | 2m16s | $0.0043 | fail | 30 | 2m7s | $0.0185 |
| hunk_merge | fail | 20 | 14m38s | $0.0630 | fail | 30 | 2m25s | $0.0176 |
| route_match | fail | 21 | 13m27s | $0.0427 | fail | 30 | 1m24s | $0.0184 |
| token_bucket | pass | 5 | 6m8s | $0.0108 | fail | 30 | 3m | $0.0181 |

## SWE-bench Verified (local subset)

Limits (summary.json): 25 steps / 25 min / $0.25 per task.

#### Arms (all evaluated records of the suite)

| arm | pass | Wilson 95% | correct | overfit | steps-to-solve median | wall median / mean | $ per task | $ per solved | generator calls / valid / length / dropped | est. $ | Jev requests (stubbed) | refused | patchEmpty | drift |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| llm-jev | 2/4 50% | [15%, 85%] | 2 | 0 | 14 (n=2) | 4m41s / 7m19s | $0.0225 | $0.0450 | 73 / 24 / 2 / 47 | $0.0441 | 178 | 0 | 1 | 0 |
| jev-off-tuned | 1/3 33% | [6%, 79%] | 1 | 0 | 12 (n=1) | 1m56s / 2m46s | $0.0270 | $0.1082 | 91 / 81 / 0 / 6 | $0.0074 | 0 | 0 | 1 | 0 |

#### Paired vs baseline (tasks evaluated in both, drift excluded)

| arm vs baseline | n | b (arm wins) | c (baseline wins) | both | neither | sign test p | median wall | Wilcoxon p | $ per task | $ per solved | correct |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| llm-jev vs jev-off-tuned | 3 | 1 | 0 | 1 | 1 | 0.500 | 4m41s vs 3m38s (1.29×) | 0.875 | 0.64× | 0.32× | 2 vs 1 |

#### Pre-registered criteria (§1.3)

- criterion 1 — pass (discordant pairs): **FAIL** — n = 3: b = 1 (llm-jev wins), c = 0 (jev-off-tuned wins), both 1, neither 1; bar b − c ≥ 4 ∧ c ≤ 2; sign test p = 0.500 (reported, not gating)
- criterion 2 — correctness: reported (not gating) — SWE: correctness = evaluator pass (criterion 1)
- criterion 3 — wall (tasks solved by both): **FAIL** — 1 tasks solved by both: mean wall 4m41s vs 57s (4.89×, bar ≤ 1.0×); mean steps-to-solve 14.0 vs 12.0 (1.17×, bar ≤ 0.5×)
- criterion 4 — cost ($ per solved, $ per task): **pass** — $ per solved $0.0250 vs $0.0781 (0.32×, bar ≤ 0.75×); $ per task $0.0167 vs $0.0260 (0.64×, bar ≤ 1×)
- criterion S1 — refused steps (blocked + declined) on the candidate: **pass** — 0 (bar 0)
- criterion S2 — patchEmpty ≤ baseline: **pass** — 0 vs 1
- criterion S3 — zero modelDrift on the candidate: **pass** — 0 record(s) with drift (excluded from the pairs)

#### Per task

| task | llm-jev | steps | wall | $ | jev-off-tuned | steps | wall | $ |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| django__django-14725 | fail | 21 | 3m31s | $0.0102 | fail | 25 | 4m32s | $0.0335 |
| django__django-14787 | fail | 17 | 10m42s | $0.0400 | null | 25 | 1m56s | $0.0301 |
| django__django-15375 | pass | 14 | 10m21s | $0.0309 | fail | 25 | 3m38s | $0.0317 |
| django__django-16100 | pass | 14 | 4m41s | $0.0089 | pass | 12 | 57s | $0.0128 |

```

## 2. Per-task metrics from the archived run records — `/tmp/iter2/metrics.py` + `/tmp/iter2/tables.py`

(iteration 1's two probes, extended with `load1`, the warm counters scraped from the per-run
`transcript.log`, the `llm:deadline` zero-token backoff events, a per-goal deadline high-water-mark check,
and the S0 timeline buckets. `--archive-runs` does **not** copy `transcript.log`, so each results dir here
also carries a `transcripts/<runId>.log` harvested from `~/.jevcode/runs/<runId>/` right after its arm.)

### 2.1 Fresh slice, candidate C1 (`llm-jev`, `JEVCODE_WARM=off`)

```
## per-task — C1 fresh 18, llm-jev, JEVCODE_WARM=off

| suite | task | pass | stop | wall s | load1 | $ tot | $ jev | jevReq | cacheHits | ranked | tested | goals | split | pl0 steps | noPatch | gen to | gen 0tok | gen s | steps |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| quixbugs | rpn_eval | True | complete | 25.3 | 4.6 | 0.000785 | 0.000379 | 3 | 0 | 0 | 226 | 1 | 0 | 0 | 1 | 0 | 0 | 9 | 2 |
| quixbugs | quicksort | True | complete | 25.6 | 4.6 | 0.000708 | 0.000322 | 4 | 0 | 0 | 222 | 1 | 0 | 0 | 1 | 0 | 0 | 9 | 2 |
| quixbugs | shortest_path_lengths | True | complete | 27.4 | 4.6 | 0.000667 | 0.000324 | 4 | 0 | 0 | 309 | 1 | 0 | 0 | 2 | 0 | 0 | 9 | 3 |
| quixbugs | shortest_paths | True | complete | 35.8 | 4.6 | 0.000662 | 0.000310 | 4 | 0 | 0 | 461 | 1 | 0 | 0 | 2 | 0 | 0 | 9 | 3 |
| quixbugs | sieve | True | complete | 26.6 | 18.2 | 0.000453 | 0.000189 | 3 | 0 | 0 | 280 | 1 | 0 | 0 | 2 | 0 | 0 | 7 | 3 |
| quixbugs | subsequences | True | complete | 26.1 | 18.9 | 0.000608 | 0.000254 | 3 | 0 | 0 | 229 | 1 | 0 | 0 | 2 | 0 | 0 | 8 | 3 |
| quixbugs | to_base | True | complete | 31.6 | 18.9 | 0.000352 | 0.000218 | 3 | 0 | 0 | 318 | 1 | 0 | 0 | 2 | 1 | 1 | 20 | 3 |
| quixbugs | topological_ordering | True | complete | 45.4 | 22.5 | 0.001247 | 0.000450 | 11 | 0 | 0 | 386 | 1 | 0 | 0 | 1 | 1 | 1 | 37 | 2 |
| ladder | deadline_queue | True | complete | 139.4 | 21.3 | 0.010677 | 0.006110 | 36 | 1 | 32 | 2685 | 1 | 0 | 1 | 2 | 0 | 0 | 72 | 3 |
| ladder | dep_order | True | complete | 136.9 | 23.5 | 0.004310 | 0.001491 | 29 | 1 | 170 | 2869 | 1 | 0 | 1 | 2 | 0 | 0 | 75 | 3 |
| ladder | csv_schema | True | complete | 432.2 | 21.3 | 0.021857 | 0.011001 | 107 | 6 | 436 | 5411 | 4 | 0 | 4 | 6 | 3 | 3 | 285 | 8 |
| ladder | hunk_merge | False | max_replans | 878.2 | 29.3 | 0.063025 | 0.033941 | 274 | 85 | 652 | 5418 | 6 | 0 | 12 | 20 | 15 | 15 | 1475 | 20 |
| ladder | route_match | False | max_replans | 807.2 | 26.1 | 0.042691 | 0.020435 | 140 | 86 | 193 | 5601 | 5 | 0 | 9 | 18 | 9 | 9 | 1229 | 21 |
| ladder | token_bucket | True | complete | 368.5 | 23.4 | 0.010798 | 0.003841 | 78 | 1 | 68 | 2084 | 3 | 0 | 3 | 4 | 5 | 5 | 190 | 5 |
| swebench | django__django-16100 | True | replan_stop | 282.0 | 75.7 | 0.008928 | 0.004252 | 25 | 0 | 10 | 5 | 1 | 0 | 3 | 13 | 3 | 3 | 121 | 14 |
| swebench | django__django-14787 | False | replan_stop | 642.5 | 73.0 | 0.040012 | 0.006279 | 68 | 75 | 381 | 252 | 1 | 0 | 6 | 17 | 9 | 9 | 1791 | 17 |
| swebench | django__django-14725 | False | max_replans | 211.8 | 59.8 | 0.010241 | 0.003617 | 24 | 15 | 20 | 10 | 1 | 0 | 4 | 20 | 9 | 9 | 341 | 21 |
| swebench | django__django-15375 | True | replan_stop | 621.7 | 77.0 | 0.030905 | 0.009986 | 61 | 20 | 340 | 793 | 1 | 0 | 3 | 13 | 14 | 14 | 903 | 14 |


### summary — C1 fresh 18, llm-jev, JEVCODE_WARM=off
pass 14/18 Wilson [54.8%, 91.0%]
$ total 0.248927 (gen 0.145529, jev 0.103398)
median wall 138.2s; loadavg1 min 4.6 median 21.9 max 77.0
Jev requests 877 / questions 11156; cacheHits 290 (cached rows 290)
ranked 2302 / tested 27559
generator: calls 254 samples 254 valid 126 timeouts 69 zero-token-timeouts 69 = 27.2% of samples; sample-s 6589 of which timeout-s 2692 = 40.9%
stop reasons: {'complete': 12, 'max_replans': 3, 'replan_stop': 3}
goals total 32; split goals 0; plausible0 steps 46
warm: {'offered': 0, 'screened': 0, 'fallbacks': 0, 'restarts': 0, 'mismatches': 0, 'coldconfirms': 0, 'disabledEvents': 0, 'notes': 0, 'scopeUnusable': 0, 'invalidations': 0}; disabledReasons []
llm:deadline (zero-token backoff) events 20; deadline shrinks after a zero-token timeout 0 []
'nothing ran' batches 133; transcripts present 18/18
timeline buckets (Σ ms, share of Σ totalMs): total 4763.9s (100.0%), synth 4620.1s (97.0%), gen 2493.1s (52.3%), jev 166.2s (3.5%), exec 119.2s (2.5%), harness 14.8s (0.3%), images 0.7s (0.0%)
replan next_move: {'gather_context': 11, 'change_approach': 13, 'stop_and_report': 4}; task_complete asked 25
replan_stop records (task, steps, wall s): [('django__django-16100', 14, 282.0), ('django__django-14787', 17, 642.5), ('django__django-15375', 14, 621.7)]

## Jev by question family (pooled)

| family | requests | questions | $ | cached |
|---|---|---|---|---|
| `propose|fix` | 339 | 339 | 0.018158 | 25 |
| `propose|buggy_line` | 209 | 209 | 0.005330 | 88 |
| `propose|where` | 191 | 191 | 0.005569 | 84 |
| `propose|slot_*` | 167 | 1138 | 0.049127 | 21 |
| `propose|attack_first` | 51 | 51 | 0.001184 | 25 |
| `propose|sketch` | 36 | 72 | 0.003346 | 4 |
| `replan|next_move` | 28 | 168 | 0.003709 | 0 |
| `complete|task_complete` | 14 | 14 | 0.001931 | 0 |
| `propose|src/apply.py` | 13 | 78 | 0.000506 | 5 |
| `propose|src/pattern.py` | 13 | 52 | 0.000276 | 8 |
| `judge|done_0` | 11 | 47 | 0.001905 | 0 |
| `propose|genuine_fix` | 9 | 31 | 0.001018 | 0 |
| `propose|general_cand_*` | 8 | 8 | 0.000463 | 0 |
| `propose|django/contrib/admin/templatetags/log.py` | 7 | 1750 | 0.001230 | 5 |
| `propose|django/template/backends/dummy.py` | 5 | 525 | 0.000232 | 4 |
| `propose|django/contrib/contenttypes/management/__init__.py` | 5 | 1250 | 0.000618 | 4 |
| `propose|django/contrib/staticfiles/testing.py` | 5 | 1250 | 0.000561 | 4 |
| `propose|django/utils/decorators.py` | 5 | 25 | 0.000074 | 4 |
| `propose|src/cells.py` | 4 | 20 | 0.000259 | 0 |
| `propose|line_4` | 3 | 35 | 0.000464 | 0 |
| `propose|line_2` | 3 | 19 | 0.000294 | 0 |
| `propose|src/bucket.py` | 3 | 15 | 0.000186 | 0 |
| `propose|candidate_*` | 3 | 10 | 0.000321 | 0 |
| `propose|src/hunks.py` | 2 | 10 | 0.000127 | 0 |
| `propose|is_reproduction_0` | 2 | 11 | 0.000198 | 0 |
```

### 2.2 Fresh slice, warm arm C2 (`llm-jev`, `JEVCODE_WARM=on`)

```
## per-task — C2 fresh 18, llm-jev, JEVCODE_WARM=on

| suite | task | pass | stop | wall s | load1 | $ tot | $ jev | jevReq | cacheHits | ranked | tested | goals | split | pl0 steps | noPatch | gen to | gen 0tok | gen s | steps |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| quixbugs | rpn_eval | True | complete | 46.7 | 155.0 | 0.000789 | 0.000379 | 3 | 0 | 0 | 225 | 1 | 0 | 0 | 1 | 0 | 0 | 10 | 2 |
| quixbugs | quicksort | True | complete | 49.4 | 155.0 | 0.000462 | 0.000302 | 4 | 0 | 0 | 221 | 1 | 0 | 0 | 2 | 1 | 1 | 20 | 3 |
| quixbugs | shortest_path_lengths | True | complete | 52.5 | 155.0 | 0.000492 | 0.000324 | 4 | 0 | 0 | 309 | 1 | 0 | 0 | 2 | 1 | 1 | 20 | 3 |
| quixbugs | shortest_paths | True | complete | 60.1 | 155.0 | 0.000488 | 0.000310 | 4 | 0 | 0 | 460 | 1 | 0 | 0 | 2 | 1 | 1 | 20 | 3 |
| quixbugs | sieve | True | complete | 42.8 | 154.1 | 0.000456 | 0.000189 | 3 | 0 | 0 | 280 | 1 | 0 | 0 | 2 | 0 | 0 | 12 | 3 |
| quixbugs | subsequences | True | complete | 44.4 | 154.1 | 0.000254 | 0.000254 | 3 | 0 | 0 | 228 | 1 | 0 | 0 | 2 | 0 | 0 | 17 | 3 |
| quixbugs | to_base | True | complete | 60.2 | 151.5 | 0.000462 | 0.000218 | 3 | 0 | 0 | 318 | 1 | 0 | 0 | 2 | 0 | 0 | 6 | 3 |
| quixbugs | topological_ordering | False | max_steps | 198.3 | 150.0 | 0.014012 | 0.004765 | 101 | 27 | 230 | 303 | 3 | 0 | 10 | 12 | 0 | 0 | 162 | 12 |
| ladder | deadline_queue | True | complete | 140.3 | 68.8 | 0.007395 | 0.004017 | 44 | 1 | 0 | 204 | 1 | 0 | 1 | 2 | 1 | 1 | 65 | 3 |
| ladder | dep_order | True | complete | 218.4 | 77.3 | 0.009109 | 0.003261 | 40 | 2 | 204 | 2685 | 1 | 0 | 1 | 3 | 1 | 1 | 172 | 4 |
| ladder | csv_schema | False | max_replans | 624.3 | 68.8 | 0.043040 | 0.014651 | 309 | 58 | 697 | 2342 | 8 | 0 | 18 | 18 | 2 | 2 | 707 | 18 |
| ladder | hunk_merge | True | complete | 538.8 | 43.6 | 0.025090 | 0.010273 | 100 | 12 | 10 | 3716 | 5 | 0 | 6 | 7 | 4 | 4 | 344 | 8 |
| ladder | token_bucket | True | complete | 280.2 | 53.3 | 0.010400 | 0.004653 | 51 | 3 | 282 | 1939 | 1 | 0 | 2 | 3 | 0 | 0 | 153 | 4 |
| ladder | route_match | False | max_replans | 885.4 | 79.1 | 0.042402 | 0.015618 | 160 | 59 | 270 | 6075 | 5 | 0 | 13 | 18 | 3 | 3 | 749 | 21 |
| swebench | django__django-16100 | True | replan_stop | 380.1 | 46.0 | 0.008066 | 0.004252 | 25 | 0 | 10 | 5 | 1 | 0 | 3 | 13 | 3 | 3 | 112 | 14 |
| swebench | django__django-14725 | False | replan_stop | 76.1 | 38.3 | 0.008418 | 0.004378 | 26 | 1 | 0 | 1 | 1 | 0 | 0 | 7 | 3 | 3 | 169 | 8 |
| swebench | django__django-14787 | False | max_replans | 747.7 | 46.0 | 0.036986 | 0.008834 | 89 | 47 | 217 | 286 | 1 | 0 | 6 | 19 | 6 | 6 | 890 | 20 |
| swebench | django__django-15375 | True | replan_stop | 295.0 | 55.9 | 0.017032 | 0.007733 | 50 | 0 | 230 | 252 | 1 | 0 | 1 | 8 | 4 | 4 | 307 | 9 |


### summary — C2 fresh 18, llm-jev, JEVCODE_WARM=on
pass 13/18 Wilson [49.1%, 87.5%]
$ total 0.225354 (gen 0.140945, jev 0.084408)
median wall 169.3s; loadavg1 min 38.3 median 78.2 max 155.0
Jev requests 1019 / questions 8158; cacheHits 210 (cached rows 210)
ranked 2150 / tested 19849
generator: calls 296 samples 296 valid 154 timeouts 30 zero-token-timeouts 30 = 10.1% of samples; sample-s 3935 of which timeout-s 878 = 22.3%
stop reasons: {'complete': 11, 'max_steps': 1, 'max_replans': 3, 'replan_stop': 3}
goals total 35; split goals 0; plausible0 steps 61
warm: {'offered': 27818, 'screened': 27818, 'fallbacks': 0, 'restarts': 0, 'mismatches': 0, 'coldconfirms': 23, 'disabledEvents': 0, 'notes': 405, 'scopeUnusable': 4, 'invalidations': 0}; disabledReasons []
llm:deadline (zero-token backoff) events 11; deadline shrinks after a zero-token timeout 0 []
'nothing ran' batches 147; transcripts present 18/18
timeline buckets (Σ ms, share of Σ totalMs): total 4740.1s (100.0%), synth 4551.0s (96.0%), gen 1872.3s (39.5%), jev 196.6s (4.1%), exec 164.5s (3.5%), harness 11.8s (0.2%), images 1.3s (0.0%)
replan next_move: {'gather_context': 12, 'change_approach': 11, 'stop_and_report': 4}; task_complete asked 37
replan_stop records (task, steps, wall s): [('django__django-16100', 14, 380.1), ('django__django-14725', 8, 76.1), ('django__django-15375', 9, 295.0)]

## Jev by question family (pooled)

| family | requests | questions | $ | cached |
|---|---|---|---|---|
| `propose|fix` | 475 | 475 | 0.023851 | 14 |
| `propose|buggy_line` | 196 | 196 | 0.005821 | 59 |
| `propose|where` | 176 | 176 | 0.005913 | 55 |
| `propose|slot_*` | 75 | 431 | 0.020951 | 0 |
| `propose|attack_first` | 65 | 65 | 0.001215 | 38 |
| `propose|candidate_*` | 34 | 201 | 0.002101 | 0 |
| `complete|task_complete` | 27 | 27 | 0.003808 | 0 |
| `propose|edit_class` | 27 | 27 | 0.000554 | 17 |
| `replan|next_move` | 27 | 162 | 0.003727 | 0 |
| `propose|sketch` | 15 | 30 | 0.001567 | 0 |
| `propose|src/cells.py` | 11 | 55 | 0.000518 | 3 |
| `propose|src/pattern.py` | 11 | 44 | 0.000276 | 6 |
| `judge|done_0` | 10 | 42 | 0.001857 | 0 |
| `propose|general_cand_*` | 9 | 9 | 0.000590 | 2 |
| `propose|src/apply.py` | 6 | 36 | 0.000362 | 0 |
| `propose|genuine_fix` | 5 | 16 | 0.000716 | 0 |
| `propose|topological_ordering.py` | 5 | 10 | 0.000098 | 2 |
| `propose|django/contrib/admin/templatetags/log.py` | 5 | 1250 | 0.001230 | 3 |
| `propose|django/template/backends/dummy.py` | 4 | 420 | 0.000231 | 3 |
| `propose|django/contrib/staticfiles/testing.py` | 4 | 1000 | 0.000561 | 3 |
| `propose|django/contrib/contenttypes/management/__init__.py` | 4 | 1000 | 0.000618 | 3 |
| `propose|django/utils/decorators.py` | 4 | 30 | 0.000194 | 2 |
| `propose|line_4` | 3 | 35 | 0.000464 | 0 |
| `propose|line_2` | 3 | 19 | 0.000294 | 0 |
| `propose|reproduction` | 3 | 14 | 0.000436 | 0 |
```

### 2.3 Timing control C3 (`jev-off-tuned`, the same 8 QuixBugs, same session)

```
## per-task — C3 fresh 8 QuixBugs, jev-off-tuned (same-session control)

| suite | task | pass | stop | wall s | load1 | $ tot | $ jev | jevReq | cacheHits | ranked | tested | goals | split | pl0 steps | noPatch | gen to | gen 0tok | gen s | steps |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| quixbugs | shortest_path_lengths | True | generator_done | 9.8 | 52.0 | 0.001779 | 0.000000 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 5 | 0 | 0 | 7 | 5 |
| quixbugs | quicksort | True | generator_done | 10.8 | 52.0 | 0.001429 | 0.000000 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 4 | 0 | 0 | 8 | 4 |
| quixbugs | shortest_paths | True | generator_done | 12.0 | 52.0 | 0.001787 | 0.000000 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 5 | 0 | 0 | 9 | 5 |
| quixbugs | sieve | True | generator_done | 9.0 | 54.4 | 0.001377 | 0.000000 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 4 | 0 | 0 | 7 | 4 |
| quixbugs | topological_ordering | True | generator_done | 14.0 | 54.9 | 0.001215 | 0.000000 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 4 | 0 | 0 | 12 | 4 |
| quixbugs | rpn_eval | True | generator_done | 39.6 | 52.0 | 0.002689 | 0.000000 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 6 | 0 | 0 | 37 | 7 |
| quixbugs | to_base | True | generator_done | 30.1 | 54.6 | 0.003774 | 0.000000 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 10 | 0 | 0 | 27 | 10 |
| quixbugs | subsequences | True | generator_done | 39.3 | 54.4 | 0.005197 | 0.000000 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 11 | 0 | 0 | 35 | 11 |


### summary — C3 fresh 8 QuixBugs, jev-off-tuned (same-session control)
pass 8/8 Wilson [67.6%, 100.0%]
$ total 0.019247 (gen 0.019247, jev 0.000000)
median wall 13.0s; loadavg1 min 52.0 median 53.2 max 54.9
Jev requests 0 / questions 0; cacheHits 0 (cached rows 0)
ranked 0 / tested 0
generator: calls 51 samples 0 valid 50 timeouts 0 zero-token-timeouts 0; sample-s 142 of which timeout-s 0 = 0.0%
stop reasons: {'generator_done': 8}
goals total 0; split goals 0; plausible0 steps 0
warm: {'offered': 0, 'screened': 0, 'fallbacks': 0, 'restarts': 0, 'mismatches': 0, 'coldconfirms': 0, 'disabledEvents': 0, 'notes': 0, 'scopeUnusable': 0, 'invalidations': 0}; disabledReasons []
llm:deadline (zero-token backoff) events 0; deadline shrinks after a zero-token timeout 0 []
'nothing ran' batches 0; transcripts present 8/8
timeline buckets (Σ ms, share of Σ totalMs): total 164.6s (100.0%), synth 0.0s (0.0%), gen 141.9s (86.2%), jev 0.0s (0.0%), exec 19.9s (12.1%), harness 2.7s (1.7%), images 0.5s (0.3%)
replan next_move: {}; task_complete asked 0

## Jev by question family (pooled)

| family | requests | questions | $ | cached |
|---|---|---|---|---|
```

### 2.4 In-sample regression arm C4 (`llm-jev` over the original 28, `JEVCODE_WARM=off`)

```
## per-task — C4 in-sample 28, llm-jev, JEVCODE_WARM=off

| suite | task | pass | stop | wall s | load1 | $ tot | $ jev | jevReq | cacheHits | ranked | tested | goals | split | pl0 steps | noPatch | gen to | gen 0tok | gen s | steps |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| quixbugs | detect_cycle | True | complete | 30.8 | 56.7 | 0.000631 | 0.000314 | 9 | 0 | 0 | 89 | 1 | 0 | 0 | 1 | 0 | 0 | 14 | 2 |
| quixbugs | gcd | True | complete | 50.6 | 71.6 | 0.000510 | 0.000201 | 3 | 0 | 0 | 176 | 1 | 0 | 0 | 1 | 0 | 0 | 5 | 2 |
| quixbugs | bucketsort | True | complete | 86.4 | 56.7 | 0.000667 | 0.000240 | 3 | 0 | 0 | 295 | 1 | 0 | 0 | 2 | 0 | 0 | 5 | 3 |
| quixbugs | find_in_sorted | True | complete | 96.6 | 56.7 | 0.000597 | 0.000308 | 4 | 0 | 0 | 472 | 1 | 0 | 0 | 2 | 0 | 0 | 11 | 3 |
| quixbugs | kth | True | complete | 75.5 | 88.6 | 0.000621 | 0.000281 | 3 | 0 | 0 | 449 | 1 | 0 | 0 | 2 | 0 | 0 | 5 | 3 |
| quixbugs | mergesort | True | complete | 66.8 | 87.4 | 0.002174 | 0.000941 | 9 | 0 | 60 | 113 | 1 | 0 | 0 | 1 | 0 | 0 | 33 | 2 |
| quixbugs | wrap | True | complete | 178.0 | 87.8 | 0.004998 | 0.002547 | 29 | 2 | 124 | 780 | 1 | 0 | 1 | 5 | 0 | 0 | 57 | 6 |
| quixbugs | bitcount | True | complete | 381.0 | 56.7 | 0.007235 | 0.001441 | 24 | 8 | 88 | 1150 | 1 | 0 | 5 | 10 | 0 | 0 | 146 | 12 |
| quixbugs | lis | True | complete | 378.0 | 87.3 | 0.015678 | 0.003776 | 68 | 7 | 237 | 1954 | 1 | 0 | 4 | 7 | 6 | 6 | 457 | 8 |
| quixbugs | shortest_path_length | True | complete | 312.7 | 88.2 | 0.005413 | 0.002023 | 38 | 38 | 386 | 1934 | 1 | 0 | 3 | 4 | 0 | 0 | 71 | 5 |
| ladder | events | True | complete | 109.0 | 98.8 | 0.001985 | 0.000523 | 11 | 0 | 19 | 584 | 1 | 0 | 1 | 2 | 0 | 0 | 26 | 3 |
| ladder | grades | True | complete | 67.0 | 172.7 | 0.001373 | 0.000350 | 8 | 0 | 0 | 363 | 1 | 0 | 0 | 1 | 0 | 0 | 18 | 2 |
| ladder | calendar_utils | True | complete | 346.9 | 98.8 | 0.007475 | 0.002681 | 55 | 3 | 323 | 2199 | 2 | 0 | 3 | 5 | 0 | 0 | 112 | 7 |
| ladder | inventory | True | complete | 168.7 | 175.4 | 0.003671 | 0.001644 | 42 | 2 | 153 | 1045 | 1 | 0 | 2 | 3 | 1 | 1 | 50 | 4 |
| ladder | profiles | True | complete | 46.1 | 158.3 | 0.000988 | 0.000275 | 7 | 0 | 0 | 218 | 1 | 0 | 0 | 1 | 0 | 0 | 17 | 2 |
| ladder | stats | True | complete | 33.3 | 148.5 | 0.001142 | 0.000416 | 8 | 0 | 0 | 177 | 1 | 0 | 0 | 1 | 0 | 0 | 16 | 2 |
| ladder | shipping | True | complete | 356.2 | 158.3 | 0.005238 | 0.001956 | 33 | 15 | 107 | 2554 | 1 | 0 | 3 | 4 | 0 | 0 | 72 | 5 |
| ladder | account | False | max_replans | 714.2 | 98.8 | 0.021442 | 0.006912 | 168 | 73 | 487 | 3464 | 4 | 2 | 14 | 19 | 0 | 0 | 283 | 20 |
| ladder | tagcloud | True | complete | 13.6 | 157.3 | 0.000960 | 0.000393 | 9 | 0 | 0 | 3 | 1 | 0 | 0 | 1 | 0 | 0 | 6 | 2 |
| ladder | textstats | True | complete | 80.3 | 150.2 | 0.002128 | 0.000639 | 13 | 1 | 23 | 425 | 1 | 0 | 1 | 2 | 0 | 0 | 23 | 3 |
| ladder | units | True | complete | 187.6 | 145.1 | 0.005271 | 0.002297 | 45 | 1 | 19 | 603 | 2 | 0 | 2 | 4 | 0 | 0 | 69 | 6 |
| ladder | table | True | complete | 510.4 | 145.2 | 0.011556 | 0.004722 | 106 | 26 | 239 | 2421 | 4 | 0 | 5 | 6 | 0 | 0 | 131 | 7 |
| swebench | sympy__sympy-15345 | True | complete | 51.7 | 44.9 | 0.005367 | 0.002849 | 18 | 0 | 0 | 4 | 1 | 0 | 0 | 1 | 0 | 0 | 66 | 2 |
| swebench | sympy__sympy-19954 | True | complete | 176.5 | 20.7 | 0.007971 | 0.003967 | 18 | 0 | 0 | 4 | 1 | 0 | 0 | 1 | 0 | 0 | 76 | 2 |
| swebench | sympy__sympy-11618 | True | complete | 180.1 | 37.5 | 0.008345 | 0.002325 | 16 | 14 | 0 | 11 | 1 | 0 | 0 | 1 | 0 | 0 | 83 | 4 |
| swebench | sympy__sympy-17139 | True | complete | 609.8 | 44.9 | 0.006645 | 0.004203 | 18 | 0 | 0 | 4 | 1 | 0 | 0 | 1 | 0 | 0 | 89 | 2 |
| swebench | django__django-15315 | True | replan_stop | 36.4 | 10.4 | 0.008356 | 0.005071 | 27 | 0 | 0 | 2 | 1 | 0 | 0 | 7 | 0 | 0 | 57 | 8 |
| swebench | django__django-15128 | True | complete | 327.7 | 20.8 | 0.025741 | 0.008272 | 49 | 15 | 295 | 513 | 1 | 0 | 2 | 5 | 8 | 8 | 628 | 6 |


### summary — C4 in-sample 28, llm-jev, JEVCODE_WARM=off
pass 27/28 Wilson [82.3%, 99.4%]
$ total 0.164177 (gen 0.102612, jev 0.061565)
median wall 138.9s; loadavg1 min 10.4 median 88.0 max 175.4
Jev requests 841 / questions 7530; cacheHits 205 (cached rows 205)
ranked 2560 / tested 22006
generator: calls 218 samples 218 valid 163 timeouts 15 zero-token-timeouts 15 = 6.9% of samples; sample-s 2626 of which timeout-s 520 = 19.8%
stop reasons: {'complete': 26, 'max_replans': 1, 'replan_stop': 1}
goals total 36; split goals 2; plausible0 steps 46
warm: {'offered': 0, 'screened': 0, 'fallbacks': 0, 'restarts': 0, 'mismatches': 0, 'coldconfirms': 0, 'disabledEvents': 0, 'notes': 0, 'scopeUnusable': 0, 'invalidations': 0}; disabledReasons []
llm:deadline (zero-token backoff) events 7; deadline shrinks after a zero-token timeout 0 []
'nothing ran' batches 238; transcripts present 28/28
timeline buckets (Σ ms, share of Σ totalMs): total 5671.4s (100.0%), synth 5344.1s (94.2%), gen 1233.0s (21.7%), jev 149.0s (2.6%), exec 306.7s (5.4%), harness 10.6s (0.2%), images 1.7s (0.0%)
replan next_move: {'gather_context': 11, 'change_approach': 4, 'stop_and_report': 2}; task_complete asked 35
replan_stop records (task, steps, wall s): [('django__django-15315', 8, 36.4)]

## Jev by question family (pooled)

| family | requests | questions | $ | cached |
|---|---|---|---|---|
| `propose|fix` | 555 | 555 | 0.025553 | 59 |
| `propose|buggy_line` | 192 | 192 | 0.005812 | 66 |
| `propose|where` | 84 | 84 | 0.005288 | 26 |
| `propose|attack_first` | 40 | 40 | 0.000519 | 24 |
| `judge|done_0` | 26 | 73 | 0.003687 | 0 |
| `replan|next_move` | 17 | 102 | 0.002201 | 0 |
| `propose|line_3` | 11 | 76 | 0.000415 | 7 |
| `propose|general_cand_*` | 11 | 11 | 0.000868 | 1 |
| `complete|task_complete` | 9 | 9 | 0.001168 | 0 |
| `propose|genuine_fix` | 9 | 32 | 0.001234 | 0 |
| `propose|src/account.py` | 9 | 18 | 0.000103 | 6 |
| `propose|edit_class` | 8 | 8 | 0.000446 | 0 |
| `propose|src/fmt.py` | 6 | 18 | 0.000169 | 2 |
| `propose|is_reproduction_0` | 6 | 45 | 0.000709 | 0 |
| `propose|line_2` | 5 | 38 | 0.000459 | 1 |
| `propose|shortest_path_length.py` | 3 | 6 | 0.000032 | 2 |
| `propose|src/shipping.py` | 3 | 6 | 0.000033 | 2 |
| `propose|src/units.py` | 3 | 6 | 0.000102 | 0 |
| `propose|django/template/backends/dummy.py` | 3 | 322 | 0.000520 | 1 |
| `propose|src/calendar_utils.py` | 2 | 4 | 0.000065 | 0 |
| `propose|sympy/combinatorics/perm_groups.py` | 2 | 255 | 0.000678 | 0 |
| `propose|sympy/printing/python.py` | 2 | 500 | 0.000564 | 1 |
| `propose|sympy/printing/pretty/stringpict.py` | 2 | 252 | 0.000293 | 1 |
| `propose|sympy/matrices/benchmarks/__init__.py` | 2 | 500 | 0.000604 | 1 |
| `propose|sympy/geometry/point.py` | 2 | 10 | 0.000061 | 1 |
```

### 2.5 In-sample warm arm C5 (`llm-jev`, QuixBugs 10 + ladder 12, `JEVCODE_WARM=on`)

```
## per-task — C5 in-sample 22, llm-jev, JEVCODE_WARM=on

| suite | task | pass | stop | wall s | load1 | $ tot | $ jev | jevReq | cacheHits | ranked | tested | goals | split | pl0 steps | noPatch | gen to | gen 0tok | gen s | steps |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| quixbugs | find_in_sorted | True | complete | 19.2 | 2.9 | 0.000620 | 0.000328 | 4 | 0 | 0 | 482 | 1 | 0 | 0 | 1 | 0 | 0 | 5 | 2 |
| quixbugs | detect_cycle | True | complete | 27.9 | 2.9 | 0.000634 | 0.000302 | 9 | 0 | 0 | 89 | 1 | 0 | 0 | 2 | 0 | 0 | 5 | 3 |
| quixbugs | gcd | True | complete | 14.5 | 8.6 | 0.000510 | 0.000201 | 3 | 0 | 0 | 176 | 1 | 0 | 0 | 1 | 0 | 0 | 2 | 2 |
| quixbugs | bucketsort | True | complete | 39.4 | 2.9 | 0.000603 | 0.000240 | 3 | 0 | 0 | 295 | 1 | 0 | 0 | 2 | 0 | 0 | 10 | 3 |
| quixbugs | kth | True | complete | 23.0 | 12.0 | 0.000630 | 0.000281 | 3 | 0 | 0 | 449 | 1 | 0 | 0 | 2 | 0 | 0 | 16 | 3 |
| quixbugs | bitcount | True | complete | 68.1 | 2.9 | 0.000986 | 0.000192 | 3 | 0 | 0 | 509 | 1 | 0 | 0 | 2 | 0 | 0 | 29 | 3 |
| quixbugs | wrap | True | complete | 60.0 | 25.8 | 0.001355 | 0.000296 | 3 | 0 | 0 | 780 | 1 | 0 | 0 | 1 | 0 | 0 | 33 | 2 |
| quixbugs | mergesort | True | complete | 162.7 | 14.9 | 0.004496 | 0.002156 | 24 | 4 | 168 | 2697 | 1 | 0 | 2 | 3 | 1 | 1 | 62 | 4 |
| quixbugs | shortest_path_length | False | max_steps | 178.2 | 20.2 | 0.016266 | 0.006201 | 130 | 182 | 938 | 941 | 2 | 0 | 7 | 12 | 1 | 1 | 345 | 12 |
| quixbugs | lis | True | complete | 279.3 | 13.6 | 0.006079 | 0.001741 | 28 | 18 | 320 | 4812 | 1 | 0 | 1 | 6 | 10 | 10 | 375 | 7 |
| ladder | events | True | complete | 40.8 | 12.7 | 0.001079 | 0.000309 | 7 | 0 | 0 | 643 | 1 | 0 | 0 | 1 | 0 | 0 | 15 | 2 |
| ladder | grades | True | complete | 22.0 | 26.3 | 0.001138 | 0.000350 | 8 | 0 | 0 | 363 | 1 | 0 | 0 | 1 | 0 | 0 | 29 | 2 |
| ladder | inventory | True | complete | 55.8 | 26.5 | 0.001038 | 0.000416 | 9 | 0 | 0 | 991 | 1 | 0 | 0 | 1 | 0 | 0 | 19 | 2 |
| ladder | calendar_utils | True | complete | 141.1 | 12.7 | 0.003318 | 0.001536 | 31 | 0 | 130 | 2516 | 2 | 0 | 0 | 3 | 0 | 0 | 68 | 5 |
| ladder | profiles | True | complete | 20.8 | 29.4 | 0.000994 | 0.000275 | 7 | 0 | 0 | 218 | 1 | 0 | 0 | 1 | 0 | 0 | 20 | 2 |
| ladder | stats | True | complete | 17.7 | 29.0 | 0.001137 | 0.000416 | 8 | 0 | 0 | 289 | 1 | 0 | 0 | 1 | 0 | 0 | 9 | 2 |
| ladder | shipping | True | complete | 71.3 | 29.0 | 0.001300 | 0.000514 | 10 | 0 | 20 | 1404 | 1 | 0 | 0 | 1 | 0 | 0 | 14 | 2 |
| ladder | tagcloud | True | complete | 10.6 | 26.2 | 0.000595 | 0.000406 | 9 | 0 | 0 | 14 | 1 | 0 | 0 | 1 | 0 | 0 | 9 | 2 |
| ladder | textstats | True | complete | 21.1 | 25.2 | 0.001092 | 0.000450 | 9 | 0 | 0 | 425 | 1 | 0 | 0 | 1 | 0 | 0 | 17 | 2 |
| ladder | table | True | complete | 181.9 | 28.4 | 0.005171 | 0.001950 | 40 | 11 | 200 | 2851 | 2 | 0 | 2 | 3 | 0 | 0 | 56 | 4 |
| ladder | units | True | complete | 96.4 | 25.2 | 0.003078 | 0.001522 | 32 | 1 | 30 | 179 | 1 | 0 | 1 | 2 | 0 | 0 | 24 | 3 |
| ladder | account | True | complete | 421.5 | 12.7 | 0.006349 | 0.001604 | 35 | 55 | 377 | 10408 | 1 | 0 | 5 | 7 | 0 | 0 | 162 | 9 |


### summary — C5 in-sample 22, llm-jev, JEVCODE_WARM=on
pass 21/22 Wilson [78.2%, 99.2%]
$ total 0.058465 (gen 0.036780, jev 0.021685)
median wall 48.3s; loadavg1 min 2.9 median 17.5 max 29.4
Jev requests 415 / questions 897; cacheHits 271 (cached rows 271)
ranked 2183 / tested 31531
generator: calls 116 samples 116 valid 80 timeouts 12 zero-token-timeouts 12 = 10.3% of samples; sample-s 1324 of which timeout-s 405 = 30.6%
stop reasons: {'complete': 21, 'max_steps': 1}
goals total 25; split goals 0; plausible0 steps 18
warm: {'offered': 33718, 'screened': 33718, 'fallbacks': 0, 'restarts': 0, 'mismatches': 0, 'coldconfirms': 50, 'disabledEvents': 0, 'notes': 371, 'scopeUnusable': 0, 'invalidations': 0}; disabledReasons []
llm:deadline (zero-token backoff) events 6; deadline shrinks after a zero-token timeout 0 []
'nothing ran' batches 207; transcripts present 22/22
timeline buckets (Σ ms, share of Σ totalMs): total 1973.3s (100.0%), synth 1954.1s (99.0%), gen 804.7s (40.8%), jev 72.9s (3.7%), exec 11.6s (0.6%), harness 2.8s (0.1%), images 0.3s (0.0%)
replan next_move: {'gather_context': 5}; task_complete asked 22

## Jev by question family (pooled)

| family | requests | questions | $ | cached |
|---|---|---|---|---|
| `propose|fix` | 382 | 382 | 0.011448 | 164 |
| `propose|buggy_line` | 140 | 140 | 0.002884 | 53 |
| `propose|where` | 42 | 42 | 0.000774 | 18 |
| `propose|attack_first` | 26 | 26 | 0.000426 | 13 |
| `judge|done_0` | 17 | 53 | 0.002092 | 0 |
| `propose|general_cand_*` | 12 | 12 | 0.000649 | 1 |
| `propose|edit_class` | 10 | 10 | 0.000110 | 8 |
| `propose|shortest_path_length.py` | 8 | 16 | 0.000064 | 6 |
| `propose|genuine_fix` | 6 | 24 | 0.000572 | 0 |
| `propose|src/account.py` | 6 | 12 | 0.000069 | 4 |
| `propose|line_3` | 5 | 42 | 0.000339 | 2 |
| `complete|task_complete` | 5 | 5 | 0.000439 | 0 |
| `replan|next_move` | 5 | 30 | 0.000595 | 0 |
| `propose|line_2` | 4 | 30 | 0.000459 | 0 |
| `propose|src/fmt.py` | 3 | 9 | 0.000084 | 1 |
| `propose|line_4` | 2 | 38 | 0.000242 | 1 |
| `propose|src/calendar_utils.py` | 2 | 4 | 0.000065 | 0 |
| `propose|src/units.py` | 2 | 4 | 0.000069 | 0 |
| `propose|detect_cycle.py` | 1 | 2 | 0.000031 | 0 |
| `propose|src/events.py` | 1 | 2 | 0.000039 | 0 |
| `propose|src/grades.py` | 1 | 2 | 0.000033 | 0 |
| `propose|src/inventory.py` | 1 | 2 | 0.000031 | 0 |
| `propose|src/profiles.py` | 1 | 2 | 0.000036 | 0 |
| `propose|src/stats.py` | 1 | 2 | 0.000035 | 0 |
| `propose|src/shipping.py` | 1 | 2 | 0.000033 | 0 |
```

### 2.6 Paired comparisons

Fresh 18 — iteration-2 `llm-jev` against the tuned generator (iteration-1 records for ladder and SWE, the
same-session C3 for QuixBugs is compared separately in §0):

```
## paired C1 (iter2 llm-jev, warm off) vs jev-off-tuned (iter1 recorded) (n=18): b=5 c=0 both=9 neither=4 sign p=0.0312
cand pass 14/18 Wilson [54.8%, 91.0%]
base pass 9/18 Wilson [29.0%, 71.0%]
median wall all: cand 138.2s base 71.1s
median wall both-solved (n=9): cand 27.4s base 20.8s ratio 1.317
per-task ratio: min 0.537 median 1.489 max 7.265; cand slower on 6/9
loadavg1 on both-solved: cand median 18.2 base median 3.2
per-task: rpn_eval 25.3s(L5)/17.0s(L3)=1.49x, quicksort 25.6s(L5)/18.6s(L3)=1.38x, shortest_path_lengths 27.4s(L5)/51.1s(L3)=0.54x, shortest_paths 35.8s(L5)/20.8s(L3)=1.72x, sieve 26.6s(L18)/10.7s(L3)=2.49x, subsequences 26.1s(L19)/36.9s(L3)=0.71x, to_base 31.6s(L19)/46.0s(L3)=0.69x, topological_ordering 45.4s(L23)/6.3s(L3)=7.26x, django__django-16100 282.0s(L76)/57.6s(L3)=4.89x
$ total: cand 0.248927 base 0.243474
Jev requests: cand 877 base 0
discordant: cand-wins ['deadline_queue', 'dep_order', 'csv_schema', 'token_bucket', 'django__django-15375'] base-wins []

```

In-sample 28 — iteration 2 against iteration 1 (both `llm-jev`, both `JEVCODE_WARM=off`):

```
## paired C4 (iter2 in-sample 28) vs iter1 in-sample 28 (n=28): b=1 c=1 both=26 neither=0 sign p=0.7500
cand pass 27/28 Wilson [82.3%, 99.4%]
base pass 27/28 Wilson [82.3%, 99.4%]
median wall all: cand 138.9s base 75.6s
median wall both-solved (n=26): cand 102.8s base 65.4s ratio 1.572
per-task ratio: min 0.331 median 2.328 max 7.607; cand slower on 22/26
loadavg1 on both-solved: cand median 88.0 base median 18.7
per-task: detect_cycle 30.8s(L57)/39.9s(L3)=0.77x, gcd 50.6s(L72)/15.4s(L15)=3.28x, bucketsort 86.4s(L57)/30.5s(L3)=2.83x, find_in_sorted 96.6s(L57)/26.0s(L3)=3.72x, kth 75.5s(L89)/30.8s(L17)=2.45x, mergesort 66.8s(L87)/80.5s(L21)=0.83x, wrap 178.0s(L88)/71.4s(L45)=2.49x, bitcount 381.0s(L57)/84.5s(L3)=4.51x, lis 378.0s(L87)/161.3s(L21)=2.34x, shortest_path_length 312.7s(L88)/274.2s(L39)=1.14x, events 109.0s(L99)/47.1s(L11)=2.31x, grades 67.0s(L173)/24.9s(L24)=2.68x, calendar_utils 346.9s(L99)/207.5s(L11)=1.67x, inventory 168.7s(L175)/143.4s(L28)=1.18x, profiles 46.1s(L158)/21.2s(L34)=2.18x, stats 33.3s(L148)/31.3s(L30)=1.06x, shipping 356.2s(L158)/79.9s(L31)=4.46x, tagcloud 13.6s(L157)/11.0s(L30)=1.23x, textstats 80.3s(L150)/95.6s(L28)=0.84x, units 187.6s(L145)/24.7s(L30)=7.61x, table 510.4s(L145)/164.2s(L30)=3.11x, sympy__sympy-15345 51.7s(L45)/156.0s(L14)=0.33x, sympy__sympy-19954 176.5s(L21)/131.2s(L9)=1.35x, sympy__sympy-11618 180.1s(L37)/59.5s(L6)=3.03x, sympy__sympy-17139 609.8s(L45)/141.6s(L14)=4.31x, django__django-15315 36.4s(L10)/35.5s(L8)=1.02x
$ total: cand 0.164177 base 0.078279
Jev requests: cand 841 base 394
discordant: cand-wins ['django__django-15128'] base-wins ['account']

```

## 3. Verdict scripts

```
# node_modules/.bin/tsx experiments/inspect/quixbugs-verdicts.mts bench/results/<dir>   (one dir per call)
=== iter2-fresh-llm-jev-quixbugs ===
quicksort                    solved equivalent      differs (differs at token 42: '<=' vs '<'); reference cases: patched 13/13, reference 13/13; identical output…
rpn_eval                     solved equivalent      differs (differs at token 110: 'b' vs 'a'); reference cases: patched 6/6, reference 6/6; identical outputs on…
shortest_path_lengths        solved gold-identical  token-identical to correct/shortest_path_lengths.py (from model_patch.diff)
shortest_paths               solved gold-identical  token-identical to correct/shortest_paths.py (from model_patch.diff)
sieve                        solved gold-identical  token-identical to correct/sieve.py (from model_patch.diff)
subsequences                 solved gold-identical  token-identical to correct/subsequences.py (from model_patch.diff)
to_base                      solved gold-identical  token-identical to correct/to_base.py (from model_patch.diff)
topological_ordering         solved equivalent      differs (differs at token 40: 'all' vs 'set'); reference cases: patched 3/3, reference 3/3; identical outputs…

Totals: solved 8/8; gold-identical 5, equivalent 3, overfit 0, unverified 0, miss 0.
Correct by this script: 8/8 (gold-identical + equivalent); 0 more pass the reference cases but differ from the reference where nothing could be compared; 0 overfit the reference cases.
written /Users/prateekjannu/Documents/vscode/JevCode/.claude/worktrees/iter2-clean/bench/results/iter2-fresh-llm-jev-quixbugs/verdicts.md
=== iter2-fresh-llm-jev-warm-quixbugs ===
quicksort                    solved equivalent      differs (differs at token 42: '<=' vs '<'); reference cases: patched 13/13, reference 13/13; identical output…
rpn_eval                     solved gold-identical  token-identical to correct/rpn_eval.py (from model_patch.diff)
shortest_path_lengths        solved gold-identical  token-identical to correct/shortest_path_lengths.py (from model_patch.diff)
shortest_paths               solved gold-identical  token-identical to correct/shortest_paths.py (from model_patch.diff)
sieve                        solved gold-identical  token-identical to correct/sieve.py (from model_patch.diff)
subsequences                 solved gold-identical  token-identical to correct/subsequences.py (from model_patch.diff)
to_base                      solved gold-identical  token-identical to correct/to_base.py (from model_patch.diff)
topological_ordering         miss   miss            no patch committed; max_steps after 12 steps; run_tests: passed 0/3, failed 3, errors 0 (timeouts 0), skipped…

Totals: solved 7/8; gold-identical 6, equivalent 1, overfit 0, unverified 0, miss 1.
Correct by this script: 7/8 (gold-identical + equivalent); 0 more pass the reference cases but differ from the reference where nothing could be compared; 0 overfit the reference cases.
written /Users/prateekjannu/Documents/vscode/JevCode/.claude/worktrees/iter2-clean/bench/results/iter2-fresh-llm-jev-warm-quixbugs/verdicts.md
=== iter2-fresh-jev-off-tuned-quixbugs ===
quicksort                    solved equivalent      differs (differs at token 42: '<=' vs '<'); reference cases: patched 13/13, reference 13/13; identical output…
rpn_eval                     solved equivalent      differs (differs at token 110: 'b' vs 'a'); reference cases: patched 6/6, reference 6/6; identical outputs on…
shortest_path_lengths        solved gold-identical  token-identical to correct/shortest_path_lengths.py (from model_patch.diff)
shortest_paths               solved gold-identical  token-identical to correct/shortest_paths.py (from model_patch.diff)
sieve                        solved gold-identical  token-identical to correct/sieve.py (from model_patch.diff)
subsequences                 solved equivalent      differs (differs at token 39: ')' vs '+'); reference cases: patched 12/12, reference 12/12; identical outputs…
to_base                      solved equivalent      differs (differs at token 17: 'if' vs 'alphabet'); reference cases: patched 10/10, reference 10/10; identical…
topological_ordering         solved gold-identical  token-identical to correct/topological_ordering.py (from model_patch.diff)

Totals: solved 8/8; gold-identical 4, equivalent 4, overfit 0, unverified 0, miss 0.
Correct by this script: 8/8 (gold-identical + equivalent); 0 more pass the reference cases but differ from the reference where nothing could be compared; 0 overfit the reference cases.
written /Users/prateekjannu/Documents/vscode/JevCode/.claude/worktrees/iter2-clean/bench/results/iter2-fresh-jev-off-tuned-quixbugs/verdicts.md
=== iter2-insample-llm-jev-quixbugs ===
bitcount                     solved gold-identical  token-identical to correct/bitcount.py (from model_patch.diff)
bucketsort                   solved gold-identical  token-identical to correct/bucketsort.py (from model_patch.diff)
detect_cycle                 solved gold-identical  token-identical to correct/detect_cycle.py (from model_patch.diff)
find_in_sorted               solved gold-identical  token-identical to correct/find_in_sorted.py (from model_patch.diff)
gcd                          solved gold-identical  token-identical to correct/gcd.py (from model_patch.diff)
kth                          solved gold-identical  token-identical to correct/kth.py (from model_patch.diff)
lis                          solved equivalent      differs (differs at token 67: 'ends' vs 'if'); reference cases: patched 12/12, reference 12/12; identical out…
mergesort                    solved equivalent      differs (differs at token 122: '==' vs '<='); reference cases: patched 14/14, reference 14/14; identical outp…
shortest_path_length         solved equivalent      differs (differs at token 169: 'None' vs '0'); reference cases: patched 4/4, reference 4/4; identical outputs…
wrap                         solved overfit         differs (differs at token 77: 'if' vs 'lines'); reference cases: patched 5/5, reference 5/5; 3/24 perturbed i…

Totals: solved 10/10; gold-identical 6, equivalent 3, overfit 1, unverified 0, miss 0.
Correct by this script: 9/10 (gold-identical + equivalent); 0 more pass the reference cases but differ from the reference where nothing could be compared; 1 overfit the reference cases.
written /Users/prateekjannu/Documents/vscode/JevCode/.claude/worktrees/iter2-clean/bench/results/iter2-insample-llm-jev-quixbugs/verdicts.md
=== iter2-insample-llm-jev-warm-quixbugs ===
bitcount                     solved gold-identical  token-identical to correct/bitcount.py (from model_patch.diff)
bucketsort                   solved gold-identical  token-identical to correct/bucketsort.py (from model_patch.diff)
detect_cycle                 solved gold-identical  token-identical to correct/detect_cycle.py (from model_patch.diff)
find_in_sorted               solved gold-identical  token-identical to correct/find_in_sorted.py (from model_patch.diff)
gcd                          solved gold-identical  token-identical to correct/gcd.py (from model_patch.diff)
kth                          solved gold-identical  token-identical to correct/kth.py (from model_patch.diff)
lis                          solved gold-identical  token-identical to correct/lis.py (from model_patch.diff)
mergesort                    solved gold-identical  token-identical to correct/mergesort.py (from model_patch.diff)
shortest_path_length         miss   miss            no patch committed; max_steps after 12 steps; run_tests: passed 2/4, failed 2, errors 0 (timeouts 0), skipped…
wrap                         solved gold-identical  token-identical to correct/wrap.py (from model_patch.diff)

Totals: solved 9/10; gold-identical 9, equivalent 0, overfit 0, unverified 0, miss 1.
Correct by this script: 9/10 (gold-identical + equivalent); 0 more pass the reference cases but differ from the reference where nothing could be compared; 0 overfit the reference cases.
written /Users/prateekjannu/Documents/vscode/JevCode/.claude/worktrees/iter2-clean/bench/results/iter2-insample-llm-jev-warm-quixbugs/verdicts.md
=== iter2-bb-llm-jev-warmoff-quixbugs ===
quicksort                    solved equivalent      differs (differs at token 42: '<=' vs '<'); reference cases: patched 13/13, reference 13/13; identical output…
rpn_eval                     solved equivalent      differs (differs at token 110: 'b' vs 'a'); reference cases: patched 6/6, reference 6/6; identical outputs on…
shortest_path_lengths        solved gold-identical  token-identical to correct/shortest_path_lengths.py (from model_patch.diff)
shortest_paths               solved gold-identical  token-identical to correct/shortest_paths.py (from model_patch.diff)
sieve                        solved gold-identical  token-identical to correct/sieve.py (from model_patch.diff)
subsequences                 solved gold-identical  token-identical to correct/subsequences.py (from model_patch.diff)
to_base                      solved gold-identical  token-identical to correct/to_base.py (from model_patch.diff)
topological_ordering         solved gold-identical  token-identical to correct/topological_ordering.py (from model_patch.diff)

Totals: solved 8/8; gold-identical 6, equivalent 2, overfit 0, unverified 0, miss 0.
Correct by this script: 8/8 (gold-identical + equivalent); 0 more pass the reference cases but differ from the reference where nothing could be compared; 0 overfit the reference cases.
written /Users/prateekjannu/Documents/vscode/JevCode/.claude/worktrees/iter2-clean/bench/results/iter2-bb-llm-jev-warmoff-quixbugs/verdicts.md
=== iter2-bb-llm-jev-warmon-quixbugs ===
quicksort                    solved gold-identical  token-identical to correct/quicksort.py (from model_patch.diff)
rpn_eval                     solved equivalent      differs (differs at token 110: 'b' vs 'a'); reference cases: patched 6/6, reference 6/6; identical outputs on…
shortest_path_lengths        solved gold-identical  token-identical to correct/shortest_path_lengths.py (from model_patch.diff)
shortest_paths               solved gold-identical  token-identical to correct/shortest_paths.py (from model_patch.diff)
sieve                        solved gold-identical  token-identical to correct/sieve.py (from model_patch.diff)
subsequences                 solved gold-identical  token-identical to correct/subsequences.py (from model_patch.diff)
to_base                      solved gold-identical  token-identical to correct/to_base.py (from model_patch.diff)
topological_ordering         miss   miss            no patch committed; max_steps after 12 steps; run_tests: passed 0/3, failed 3, errors 0 (timeouts 0), skipped…

Totals: solved 7/8; gold-identical 6, equivalent 1, overfit 0, unverified 0, miss 1.
Correct by this script: 7/8 (gold-identical + equivalent); 0 more pass the reference cases but differ from the reference where nothing could be compared; 0 overfit the reference cases.
written /Users/prateekjannu/Documents/vscode/JevCode/.claude/worktrees/iter2-clean/bench/results/iter2-bb-llm-jev-warmon-quixbugs/verdicts.md
=== iter2-bb-jev-off-tuned-quixbugs ===
quicksort                    solved gold-identical  token-identical to correct/quicksort.py (from model_patch.diff)
rpn_eval                     solved overfit         differs (differs at token 93: '(' vs 'float'); reference cases: patched 6/6, reference 6/6; 13/24 perturbed i…
shortest_path_lengths        solved gold-identical  token-identical to correct/shortest_path_lengths.py (from model_patch.diff)
shortest_paths               solved gold-identical  token-identical to correct/shortest_paths.py (from model_patch.diff)
sieve                        solved gold-identical  token-identical to correct/sieve.py (from model_patch.diff)
subsequences                 solved gold-identical  token-identical to correct/subsequences.py (from model_patch.diff)
to_base                      solved equivalent      differs (differs at token 13: 'if' vs 'result'); reference cases: patched 10/10, reference 10/10; identical o…
topological_ordering         solved equivalent      differs (differs at token 40: 'nextnode' vs 'set'); reference cases: patched 3/3, reference 3/3; identical ou…

Totals: solved 8/8; gold-identical 5, equivalent 2, overfit 1, unverified 0, miss 0.
Correct by this script: 7/8 (gold-identical + equivalent); 0 more pass the reference cases but differ from the reference where nothing could be compared; 1 overfit the reference cases.
written /Users/prateekjannu/Documents/vscode/JevCode/.claude/worktrees/iter2-clean/bench/results/iter2-bb-jev-off-tuned-quixbugs/verdicts.md
```

```
# node_modules/.bin/tsx experiments/inspect/ladder-verdicts.mts bench/results/<dir>
=== iter2-fresh-llm-jev-ladder-long2 ===
csv_schema         short solved equivalent      differs from gold in cells.py (differs at token 422: 'WIDEST' vs 'left'), infer.py (differs at token 67: 'kind' vs 'if'…
deadline_queue     short solved equivalent      differs from gold in schedule.py (differs at token 117: '==' vs '<='); identical results, exception classes and post-ca…
dep_order          short solved equivalent      differs from gold in layers.py (differs at token 97: 'max' vs '1'); identical results, exception classes and post-call …
hunk_merge         short miss   miss            no patch committed; max_replans after 20 steps
route_match        short miss   miss            a committed patch still fails; max_replans after 21 steps
token_bucket       short solved overfit         strong: differs from gold in bucket.py (differs at token 172: 'self' vs 'if'), limiter.py (differs at token 232: 'is' v…

short tier: solved 4/6, correct 3/6 (gold-identical 0, equivalent 3); overfit 1 — strong 1 (token_bucket), weak only 0; unverified 0, miss 2
long tier: solved 0/0, correct 0/0 (gold-identical 0, equivalent 0); overfit 0 — strong 0, weak only 0; unverified 0, miss 0
all tier: solved 4/6, correct 3/6 (gold-identical 0, equivalent 3); overfit 1 — strong 1 (token_bucket), weak only 0; unverified 0, miss 2
written /Users/prateekjannu/Documents/vscode/JevCode/.claude/worktrees/iter2-clean/bench/results/iter2-fresh-llm-jev-ladder-long2/verdicts.md
=== iter2-fresh-llm-jev-warm-ladder-long2 ===
csv_schema         short miss   miss            no patch committed; max_replans after 18 steps
deadline_queue     short solved equivalent      differs from gold in schedule.py (differs at token 117: '==' vs '<='); identical results, exception classes and post-ca…
dep_order          short solved equivalent      differs from gold in layers.py (differs at token 97: 'max' vs '1'), order.py (differs at token 62: '1' vs 'FIRST_ROUND'…
hunk_merge         short solved overfit         weak only: differs from gold in merge.py (differs at token 196: 'left' vs 'list'); 1/352 differ (merge 1; 1 exception-c…
route_match        short miss   miss            a committed patch still fails; max_replans after 21 steps
token_bucket       short solved overfit         strong: differs from gold in bucket.py (differs at token 172: 'self' vs 'if'); 8/644 differ (Limiter.allow 2, Limiter.r…

short tier: solved 4/6, correct 2/6 (gold-identical 0, equivalent 2); overfit 2 — strong 1 (token_bucket), weak only 1 (hunk_merge); unverified 0, miss 2
long tier: solved 0/0, correct 0/0 (gold-identical 0, equivalent 0); overfit 0 — strong 0, weak only 0; unverified 0, miss 0
all tier: solved 4/6, correct 2/6 (gold-identical 0, equivalent 2); overfit 2 — strong 1 (token_bucket), weak only 1 (hunk_merge); unverified 0, miss 2
written /Users/prateekjannu/Documents/vscode/JevCode/.claude/worktrees/iter2-clean/bench/results/iter2-fresh-llm-jev-warm-ladder-long2/verdicts.md
=== iter2-insample-llm-jev-ladder ===
calendar_utils     short solved equivalent      differs from gold in calendar_utils.py (differs at token 312: ',' vs ')'); identical results, exception classes and pos…
events             short solved gold-identical  token-identical to gold/ (events.py; from model_patch.diff (535 bytes))
grades             short solved gold-identical  token-identical to gold/ (grades.py; from model_patch.diff (814 bytes))
inventory          short solved gold-identical  token-identical to gold/ (inventory.py; from model_patch.diff (929 bytes))
profiles           short solved equivalent      differs from gold in profiles.py (differs at token 75: 'nick' vs 'if'); identical results, exception classes and post-c…
shipping           short solved gold-identical  token-identical to gold/ (shipping.py; from model_patch.diff (509 bytes))
stats              short solved overfit         weak only: differs from gold in stats.py (differs at token 81: 'ordered' vs 'if'); 2/111 differ (median 1, summary 1; 2…
table              short solved gold-identical  token-identical to gold/ (fmt.py, table.py; from model_patch.diff (1052 bytes))
tagcloud           short solved gold-identical  token-identical to gold/ (tagcloud.py; from model_patch.diff (336 bytes))
textstats          short solved equivalent      differs from gold in textstats.py (differs at token 183: '-' vs 'kv'); identical results, exception classes and post-ca…
units              short solved gold-identical  token-identical to gold/ (units.py; from model_patch.diff (704 bytes))

short tier: solved 11/12, correct 10/12 (gold-identical 7, equivalent 3); overfit 1 — strong 0, weak only 1 (stats); unverified 0, miss 1
long tier: solved 0/0, correct 0/0 (gold-identical 0, equivalent 0); overfit 0 — strong 0, weak only 0; unverified 0, miss 0
all tier: solved 11/12, correct 10/12 (gold-identical 7, equivalent 3); overfit 1 — strong 0, weak only 1 (stats); unverified 0, miss 1
written /Users/prateekjannu/Documents/vscode/JevCode/.claude/worktrees/iter2-clean/bench/results/iter2-insample-llm-jev-ladder/verdicts.md
=== iter2-insample-llm-jev-warm-ladder ===
calendar_utils     short solved equivalent      differs from gold in calendar_utils.py (differs at token 312: ',' vs ')'); identical results, exception classes and pos…
events             short solved gold-identical  token-identical to gold/ (events.py; from model_patch.diff (535 bytes))
grades             short solved gold-identical  token-identical to gold/ (grades.py; from model_patch.diff (814 bytes))
inventory          short solved gold-identical  token-identical to gold/ (inventory.py; from model_patch.diff (929 bytes))
profiles           short solved equivalent      differs from gold in profiles.py (differs at token 75: 'nick' vs 'if'); identical results, exception classes and post-c…
shipping           short solved gold-identical  token-identical to gold/ (shipping.py; from model_patch.diff (509 bytes))
stats              short solved overfit         weak only: differs from gold in stats.py (differs at token 81: 'ordered' vs 'if'); 2/111 differ (median 1, summary 1; 2…
table              short solved gold-identical  token-identical to gold/ (fmt.py, table.py; from model_patch.diff (1052 bytes))
tagcloud           short solved equivalent      differs from gold in tagcloud.py (differs at token 8: 'dataclasses' vs 'collections'); identical results, exception cla…
textstats          short solved gold-identical  token-identical to gold/ (textstats.py; from model_patch.diff (930 bytes))
units              short solved equivalent      differs from gold in units.py (differs at token 262: 'float' vs 'text'); identical results, exception classes and post-…

short tier: solved 12/12, correct 11/12 (gold-identical 6, equivalent 5); overfit 1 — strong 0, weak only 1 (stats); unverified 0, miss 0
long tier: solved 0/0, correct 0/0 (gold-identical 0, equivalent 0); overfit 0 — strong 0, weak only 0; unverified 0, miss 0
all tier: solved 12/12, correct 11/12 (gold-identical 6, equivalent 5); overfit 1 — strong 0, weak only 1 (stats); unverified 0, miss 0
written /Users/prateekjannu/Documents/vscode/JevCode/.claude/worktrees/iter2-clean/bench/results/iter2-insample-llm-jev-warm-ladder/verdicts.md
```

## 4. Ring 1 — `quick.mts --ring 1` ($0), run twice: plane off, then plane on

**Ring 1, `JEVCODE_WARM=off`:**

```
--- RING 1, JEVCODE_WARM=off  18:08:22Z loadavg { 11.35 18.96 25.75 }

Ring 1 — the `--jev off` safety gate, paired against the same tasks with Jev on (no network, no API)

  --jev off keeps what Jev solves, quixbugs  Jev on 1/3 pass → off 2/3              every task Jev-on solves, Jev-off solves pass
    only slower, quixbugs                    1.49× the Jev-on wall over 1 task(s)   report (a router fallback costs wall, never correctness) ·
  --jev off keeps what Jev solves, ladder    Jev on 2/2 pass → off 1/2; lost units  every task Jev-on solves, Jev-off solves FAIL
    only slower, ladder                      0.80× the Jev-on wall over 1 task(s)   report (a router fallback costs wall, never correctness) ·
    faster AND unsolved, ladder              units                                  the false-green signature: replanned into the cap FAIL
  replay of the 28 head-to-head run dirs     not landed                             src/loop/replay.ts + `inspect --replay` (needs src/cli/**) ·

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

quick: a gate failed (git d86c385)
--- RING1-OFF exit 1  18:25:51Z
```

**Ring 1, `JEVCODE_WARM=on`** (the condition `docs/DECISIONS.md` set for returning the default to on):

```
--- RING 1, JEVCODE_WARM=on  18:25:51Z loadavg { 45.10 136.94 103.90 }

Ring 1 — the `--jev off` safety gate, paired against the same tasks with Jev on (no network, no API)

  --jev off keeps what Jev solves, quixbugs  Jev on 3/3 pass → off 3/3              every task Jev-on solves, Jev-off solves pass
    only slower, quixbugs                    1.31× the Jev-on wall over 3 task(s)   report (a router fallback costs wall, never correctness) ·
  --jev off keeps what Jev solves, ladder    Jev on 2/2 pass → off 1/2; lost units  every task Jev-on solves, Jev-off solves FAIL
    only slower, ladder                      0.67× the Jev-on wall over 1 task(s)   report (a router fallback costs wall, never correctness) ·
    faster AND unsolved, ladder              units                                  the false-green signature: replanned into the cap FAIL
  replay of the 28 head-to-head run dirs     not landed                             src/loop/replay.ts + `inspect --replay` (needs src/cli/**) ·

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

quick: a gate failed (git d86c385)
--- RING1-ON exit 1  18:38:23Z
```

## 5. Ring 2 — `quick.mts --ring 2 --live --spend-cap 0.05` (`JEVCODE_WARM=off`)

```
--- RING 2 live, JEVCODE_WARM=off  18:38:23Z loadavg { 13.60 27.72 54.45 }

Ring 2 — the tiny live tasks (LIVE)

  task            pass  steps   wall      wall/step    $        jev req  jevMs   harnessMs  verdict     vs baseline
  gcd             true      2    20.4 s     10.2 s   $0.0002        3 750.9 ms   137.3 ms  —           +27 %
  kth             true      2    31.7 s     15.9 s   $0.0003        3 574.8 ms   107.1 ms  —           -4 %
  mergesort       true      6   110.8 s     18.5 s   $0.0026       29    4.8 s   195.2 ms  —           -38 %
  tagcloud        true      2     8.7 s      4.3 s   $0.0004        9    1.9 s   191.1 ms  —           -21 %
  units           true      6   241.3 s     40.2 s   $0.0013       26    5.5 s   338.8 ms  —           +997 %

  accept rule (§5 step 5):
    median wall −≥ 10 % on ≥ 3 tasks           2/5  NOT met
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

quick: a gate failed (git d86c385)
--- RING2 exit 1  18:44:17Z
```

## 6. Warm, escalation and deadline events (grep over the harvested run transcripts)

```
warm counters scraped from the per-run transcripts (the sieve's `warmNote` clause). Note that the note is
emitted whether or not the plane is on: with `JEVCODE_WARM=off` it reads `warm 0/0` and is printed only when some
other counter it carries is non-zero — which is why the two warm-OFF rows with any note at all are the ones where
`scope_unusable` fired. `scope_unusable` is therefore a sieve counter reported through the warm note, not a warm
event, and it is excluded from the warm-on total.

arm                                 notes  offered  screened  fallb  restart  mismatch  coldconf  dlRecheck  scopeUnus  disabled
C1 fresh 18, warm OFF                   0        0         0      0        0         0         0          0          0         0
C2 fresh 18, warm ON                  405    27818     27818      0        0         0        23         89          4         0
C4 in-sample 28, warm OFF               0        0         0      0        0         0         0          0          0         0
C5 in-sample 22, warm ON              371    33718     33718      0        0         0        50        133          0         0
C6a back-to-back QB, warm OFF           0        0         0      0        0         0         0          0          0         0
C6b back-to-back QB, warm ON           16     2305      2305      0        0         0        12         17          0         0
C7a back-to-back ladder, warm OFF       2        0         0      0        0         0         0          0          5         0
C7b back-to-back ladder, warm ON      329    29619     29619      0        0         0        20         47          0         0
-- the four warm-ON arm groups       1121    93460     93460      0        0         0       105        286          4         0

disabledReason strings, all arms: NONE

replan escalation ladder (change 7 `run:` signature, change 9 `done:` signature):

  C1 fresh 18, warm OFF: done proposal -> change_approach escalation x8, run command with the same result -> change_approach escalation x1
  C2 fresh 18, warm ON: done proposal -> change_approach escalation x5, run command with the same result -> change_approach escalation x2
  C4 in-sample 28, warm OFF: done proposal -> change_approach escalation x3, run command with the same result -> change_approach escalation x1
  C5 in-sample 22, warm ON: done proposal -> change_approach escalation x1
  C6a back-to-back QB, warm OFF: none
  C6b back-to-back QB, warm ON: done proposal -> change_approach escalation x1
  C7a back-to-back ladder, warm OFF: none
  C7b back-to-back ladder, warm ON: none

zero-token-timeout deadline back-off (`llm:deadline`) and per-goal high-water mark:

  C1 fresh 18, warm OFF: llm:deadline events 20; deadlines that SHRANK for a goal after a zero-token timeout: 0
  C2 fresh 18, warm ON: llm:deadline events 11; deadlines that SHRANK for a goal after a zero-token timeout: 0
  C4 in-sample 28, warm OFF: llm:deadline events 7; deadlines that SHRANK for a goal after a zero-token timeout: 0
  C5 in-sample 22, warm ON: llm:deadline events 6; deadlines that SHRANK for a goal after a zero-token timeout: 0
  C6a back-to-back QB, warm OFF: llm:deadline events 0; deadlines that SHRANK for a goal after a zero-token timeout: 0
  C6b back-to-back QB, warm ON: llm:deadline events 0; deadlines that SHRANK for a goal after a zero-token timeout: 0
  C7a back-to-back ladder, warm OFF: llm:deadline events 4; deadlines that SHRANK for a goal after a zero-token timeout: 0
  C7b back-to-back ladder, warm ON: llm:deadline events 5; deadlines that SHRANK for a goal after a zero-token timeout: 0
```

### 6.1 The warm-on pass losses, side by side with the same task cold

Every warm-on QuixBugs loss has the same signature: a batch containing a diverging candidate is screened at
the **lane run** cap instead of the sieve's adapted **per-case** timeout, the run-median estimate inflates
~14–23×, the step's test wall drains, and every later batch reports `0 tested … (nothing ran)`.

`topological_ordering`, C6 back-to-back (warm on, 210.1 s, `max_steps` 12) — first four verify events:

```
verify · g1: 185 tested on 8 lanes (182 unchanged, 3 timeout); runs left 1315, test wall left 57 s; run median 11655 ms, t_run 11655 ms; warm 185/185, screen 84973 ms, 3 deadline rechecks cold · 185 candidates, 
verify · g1: 5 tested on 8 lanes (4 unchanged, 1 timeout); runs left 1310, test wall left 30 s; run median 14098 ms, t_run 14098 ms; warm 5/5, screen 14017 ms, 1 deadline recheck cold · 5 candidates, 5 tested
verify · g1: 5 tested on 8 lanes (5 unchanged); runs left 1305, test wall left 29 s; warm 5/5, screen 374 ms · 5 candidates, 5 tested
verify · g1: 5 tested on 8 lanes (5 unchanged); runs left 1300, test wall left 29 s; warm 5/5, screen 399 ms · 5 candidates, 5 tested
verify · g1: 5 tested on 8 lanes (1 timeout, 4 unchanged); runs left 1295, test wall left 1 s; run median 14093 ms, t_run 14093 ms; warm 5/5, screen 14083 ms, 1 deadline recheck cold · 5 candidates, 5 tested
...
verify · g1: 0 tested on 8 lanes (nothing ran); runs left 16, test wall left 11 s · 0 candidates, 0 tested
verify · g1: 0 tested on 8 lanes (nothing ran); runs left 16, test wall left 11 s · 0 candidates, 0 tested
(× 275 such batches)
```

The same task, same build, same batch, **warm off** (C6 back-to-back, 42.6 s, solved):

```
verify · g1: 185 tested on 8 lanes (182 unchanged, 3 timeout); runs left 1315, test wall left 65 s; run median 510 ms, t_run 510 ms · 185 candidates, 185 tested
verify · g1: 199 tested on 8 lanes (195 unchanged, 3 timeout, 1 plausible); runs left 1115, test wall left 52 s; run median 174 ms, t_run 174 ms · 199 candidates, 199 tested
verify · g1: 1 tested on 8 lanes (1 plausible); runs left 1113, test wall left 51 s; run median 104 ms, t_run 104 ms · 1 candidates, 1 tested
```

`shortest_path_length`, C5 in-sample (warm on, `max_steps` 12) and C4 (warm off, solved) — same signature:

```
warm ON:
verify · g1: 438 tested on 8 lanes (283 regressed, 155 unchanged); runs left 1054, test wall left 73 s; warm 446/446, screen 89713 ms · 438 candidates, 438 tested
verify · g1: 437 tested on 8 lanes (325 regressed, 110 unchanged, 2 timeout); runs left 617, test wall left 30 s; run median 12242 ms, t_run 12242 ms; warm 437/437, screen 136470 ms, 2 deadli
warm OFF:
verify · g1: 438 tested on 8 lanes (283 regressed, 155 unchanged); runs left 1054, test wall left 29 s; run median 869 ms, t_run 869 ms; load ×2.5, case timeout 500→1271 m
verify · g1: 24 tested on 8 lanes (24 regressed); runs left 1030, test wall left 24 s; run median 1178 ms, t_run 1178 ms · 24 candidates, 24 tested
```

### 6.2 The pre-registered warm criterion

```
PRE-REGISTERED warm-default criterion — written 2026-09-22 before the load-matched back-to-back
QuixBugs pair (C6) was run, and before any warm-on/warm-off wall ratio at matched load was seen.
(At the time of writing: C1 warm-off and C2.1/C2.2 warm-on had run, but at loadavg 4.6-29 vs
150-155 / 43-79 respectively, so no comparable wall number existed.)

Flip the warm default to ON only if ALL FOUR hold:
 1. SAFETY. Zero wedges (no run at 0 % CPU with no children), zero `disabledReason` events, and
    fallbacks + restarts + screen:mismatch = 0 over every warm-on run of this measurement.
 2. PASS PARITY. Warm-on pass count >= warm-off pass count on the same task list, and on the
    load-matched pair no discordant task where warm-off passes and warm-on fails (c = 0).
 3. WALL WIN. On the load-matched back-to-back QuixBugs pair, the per-task warm-on/warm-off wall
    ratio has median <= 0.90 (>= 10 % median speed-up) and is < 1.0 on a majority of the 8 tasks.
 4. RING 1 PASSES WITH THE PLANE ON (the condition docs/DECISIONS.md already set on 2026-09-22).

If 1 holds but 3 or 4 does not -> KEEP OFF.
If 1 fails -> KEEP OFF, and the failure is the headline.
If 1, 2 and 4 hold and 3 is only missed because the matched pair is a single n = 8 run ->
NEED MORE DATA (a repeat of the matched pair on an unloaded machine).
```

## 7. The second back-to-back pair (C7): ladder long-2, warm off then warm on

| task | warm off | load | warm on | load | on/off |
|---|---|---|---|---|---|
| csv_schema | pass 779.0 s (14 st) | 38.2 | pass 526.6 s (7 st) | 46.3 | 0.68× |
| deadline_queue | pass 193.8 s (3 st) | 38.2 | pass 181.5 s (3 st) | 46.3 | 0.94× |
| dep_order | pass 274.5 s (4 st) | 63.0 | pass 635.9 s (9 st) | 100.1 | 2.32× |
| hunk_merge | pass 421.2 s (7 st) | 114.2 | pass 498.2 s (8 st) | 88.4 | 1.18× |
| route_match | **fail** 829.1 s (19 st) | 93.7 | **fail** 811.5 s (24 st) | 120.5 | 0.98× |
| token_bucket | pass 163.0 s (3 st) | 42.1 | pass 400.6 s (6 st) | 75.3 | 2.46× |

warm off: pass 5/6, median wall 347.8 s, $ 0.114396, median loadavg1 52.6

warm on: pass 5/6, median wall 512.4 s, $ 0.162694, median loadavg1 81.9

warm on/off on the 5 both solved: min 0.676 · median 1.183 · max 2.458; warm on faster on 2/5

Warm counters for C7b: 329 notes, **29,619 offered / 29,619 screened, 0 fallbacks, 0 restarts, 0 screen:mismatch,
0 `disabledReason`**, 20 cold confirms, 47 deadline rechecks.

Grand total over all seven warm-on arms: **93,460 offered / 93,460 screened, 0 fallbacks, 0 restarts,
0 screen:mismatch, 0 `disabledReason`**, 105 cold confirms, 286 deadline rechecks, 4 `scope_unusable`.

Pass parity over all seven pairs (54 paired tasks):

| pair | warm off | warm on | b (warm wins) | c (cold wins) | off load (med) | on load (med) |
|---|---|---|---|---|---|---|
| fresh QuixBugs 8 | 8/8 | 7/8 | 0 | 1 (`topological_ordering`) | 11.4 | 154.5 |
| fresh ladder long-2 6 | 4/6 | 4/6 | 1 (`hunk_merge`) | 1 (`csv_schema`) | 23.4 | 68.8 |
| fresh SWE 4 (plane is a no-op here) | 2/4 | 2/4 | 0 | 0 | 74.4 | 46.0 |
| in-sample QuixBugs 10 | 10/10 | 9/10 | 0 | 1 (`shortest_path_length`) | 79.4 | 10.3 |
| in-sample ladder 12 | 11/12 | 12/12 | 1 (`account`) | 0 | 149.3 | 26.3 |
| back-to-back QuixBugs 8 (matched load) | 8/8 | 7/8 | 0 | 1 (`topological_ordering`) | 12.2 | 35.0 |
| back-to-back ladder long-2 6 | 5/6 | 5/6 | 0 | 0 | 52.6 | 81.9 |
| **all seven pairs, 54 paired tasks** | | | **2** | **4** | | |
