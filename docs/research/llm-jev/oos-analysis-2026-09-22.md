# Where the out-of-sample llm-jev wall and dollars actually went

**Records (correction to the brief).** `bench/results/oos-*/` holds only `tasks.jsonl`, `summary.json`, `comparison.md`, `verdicts.md`; per-task detail is in `~/.jevcode/runs/<runId>/{steps,decisions,jev,generator}.jsonl` plus `run.json`, `state.json`, `model_patch.diff`, keyed by `tasks.jsonl`'s `runId`. All 44 OOS run dirs are present; every number below comes from them (probes `/tmp/probe{3,5,6,7,8,9}.mjs`). Buckets are `steps.jsonl` `timing.*`, and Σ`totalMs` = `wallMs` exactly. **`synthLocal` = `synthMs − generatorMs − jevMs − execMs` = in-process candidate enumeration plus shadow-workspace pytest lanes — not `execMs`, and the largest bucket everywhere.**

## Q1 — where the wall goes

| suite (llm-jev) | wall | generator | Jev | sandbox exec | harness | **synthLocal** | outside synth |
|---|---|---|---|---|---|---|---|
| QuixBugs 10 | 449 s | 123 s (27 %) | 11 s (2 %) | 28 s (6 %) | 2 s | **255 s (57 %)** | 33 s (7 %) |
| ladder long 8 | 4,692 s | 1,479 s (32 %) | 323 s (7 %) | 29 s (1 %) | 3 s | **2,799 s (60 %)** | 61 s (1 %) |
| SWE 4 | 2,949 s | 641 s (22 %) | 229 s (8 %) | 251 s (9 %) | 3 s | **1,556 s (53 %)** | 273 s (9 %) |

Per unsolved task (`wall|gen|jev|exec|synthLocal`, s): crossfile `893|351|93|8|427`, long_chain `851|245|72|6|513`, six_hunks `742|282|46|4|401`, regress_trap `545|181|30|2|327`, masked `512|90|27|2|386`, sympy-16792 `1500|281|135|119|819`, sympy-22080 `872|224|71|76|422`, sympy-13798 `323|79|14|34|153`, sympy-20428 `273|57|9|22|162`. The only ladder task solved slower than baseline is shared_frame `449|118|26|3|297` vs 148 s (3.03×); the other two slower both-solved tasks are QuixBugs `levenshtein` (83 vs 43 s) and `knapsack` (79 vs 79 s).


**Dominant stage, every suite: local candidate verification** — 35,064 shadow test runs on ladder (median `tRunMs` 270–1,325 ms), 2,228 on SWE (1,116–1,574 ms). Second is generator sampling, and **48 % of ladder generator sample-seconds (1,170 of 2,423 s) and 60 % of SWE's (1,532 of 2,538 s) are samples that timed out at the ~10 s adaptive deadline with 0 output tokens** (82/244 and 51/130 calls, `generator.jsonl` `stopReason:"timeout"`; long_chain `20260922-055835-jrb5hkbr` 27 of 44). QuixBugs: 0 timeouts in 14 calls. Jev is never the wall (2–8 %); harness overhead ≤ 3 s/suite.

## Q2 — why 2,330 Jev requests (77,345 questions, 563 s, $0.6233)

| stage \| family | requests | questions | s | $ |
|---|---|---|---|---|
| propose \| SIEVE/RANK `candidate_*` | **707** (30 %) | **64,961** (84 %) | 236 | **$0.4260** (68 %) |
| propose \| `buggy_line` + `where` (localise) | 704 | 704 | 137 | $0.0388 |
| propose \| sketch `slot_*` · `fix` · file pick `<path>` | 203 · 204 · 119 | 1,362 · 209 · 9,068 | 110 | $0.1072 |
| complete \| `task_complete` · replan · risk | 127 · 39 · 51 | 127 · 273 · 102 | 46 | $0.0330 |
| **guard/probe arbitration** (`genuine_fix`+`general_cand_*`) | **28** (1.2 %) | 32 | 6 | $0.0016 |

Per task the split is bimodal: QuixBugs 3–11 requests (median 4.5, sieve on 1 of 10) vs ladder 37–446 and SWE 34–432.

**Zero information.** (a) All 65,076 `candidate_*` noul answers are "no": p50 0.03, p90 0.06, 96.3 % in [0.0, 0.1), 13 answers ≥ 0.5. (b) **99 % of ladder sieve requests (393/397) and 100 % of SWE's (302/302) fired in steps whose search found `plausible = 0`** — ranking a pool with no fix in it, which a goal-test run decides for free. (c) **454 of 2,330 requests (19.5 %) repeat a `requestHash` already issued in the same run** (ladder 339/1,532, SWE 115/744, QuixBugs 0): same question, same state, no cache hit. (d) Degenerate: `risk|destructive` and `risk|irreversible` 51 questions each with **1 distinct answer**; `replan|task_impossible` 39, 1 answer; `replan|next_move` 84.6 % `gather_context`; `propose|fix` 93.6 % `none_of_these`; `complete|task_complete` 87.7 % < 0.5.

## Q3 — the five ladder losses

| task | stop | goals | sites | enum / tested | **plausible** | LLM samples → valid → distinct (timeouts) | replan `next_move` answers |
|---|---|---|---|---|---|---|---|
| crossfile | max_replans (5) | 7 (one per failing test, 3 files) | 168 | 12,153 / 5,138 | **0** | 30 → 7 → 5 (4 to, 19 cancelled) | gather_context ×5 |
| six_hunks | max_replans (5) | 3 (3 parametrised tests each) | 116 | 9,084 / 4,607 | **0** | 26 → 8 → 5 (9) | gather_context ×5 |
| long_chain | replan_stop (4) | 3 | 136 | 13,028 / 5,992 | **0** | 41 → 15 → 8 (24) | gather_context ×4 |
| masked | replan_stop (3) | **1** (4 failing tests, one file) | 69 | 7,027 / 4,525 | **0** | 23 → 13 → 5 (7) | gather_context ×3 |
| regress_trap | replan_stop (3) | 2 | 82 | 6,530 / 3,760 | 2 (1 committed) | 22 → 9 → 10 (7) | gather_context ×3 |

**The guard dropped nothing**: `arbitrated` is false on every step of all five, `clusters 0` on four of five, and four of five never produced one passing candidate — the failure is generation, not selection. Dedupe among *valid* samples is 35 % (78 valid → 51 distinct) but the loss upstream is bigger: **186 samples → 78 valid (42 %), 63 timeouts, 34 cancelled**. Decomposition fails both ways — masked is one goal over 4 coupled tests, crossfile eight single-test goals over a defect needing coupled hunks. Every replan chose `gather_context` and the next step was always the same `pytest -q '<same file>'` re-run (crossfile `20260922-054652-dcxbrltg` steps 1–10, 14–17; six_hunks `20260922-061926-da3ho35c` steps 1–7, 11–12): 20 and 12 steps in which **no patch was ever proposed**.

What would turn them: a longer sampling deadline first, then coupled-hunk goals. A longer round would not — 12,000–13,000-candidate seed sweeps at `plausible 0` say the seed grammar cannot reach these defects; nor a different completion rule (`task_complete` never exceeded 0.02).

## Q4 — SWE 0/4, $0.3885, 744 requests

| instance | wall | steps | goals | phase/mode | enum / ranked / **tested** | plausible | LLM samples→valid | Jev req (top families) | patch |
|---|---|---|---|---|---|---|---|---|---|
| sympy-16792 | 1,500 s (wall_time) | 19 | 1 | **SEEDS only, RANK ×12** | 28,878 / 27,754 / **1,191** | 0 | 62 → **0** (24 to) | 432 (sieve 178, fix 110, where 55) | empty |
| sympy-22080 | 872 s | 10 | 1 | SEEDS ×6 | 14,048 / 13,448 / 796 | 0 | 28 → 1 (23 to) | 234 (sieve 115, fix 43) | empty |
| sympy-13798 | 323 s | 18 | 1 | SEEDS ×3 | 1,414 / 550 / 217 | 0 | 17 → 13 | 44 (judge 18) | empty |
| sympy-20428 | 273 s (`complete`) | 4 | 1 | SEEDS/LLM | 764 / 764 / 21 | 1 | 8 → 3 | 34 | 828 B, **eval exit 1** |

**The 25 minutes on 16792 went to verification**, not localisation or generation: synthLocal 819 s (55 %), generator 281 s (19 %, incl. 24 zero-token timeouts), Jev 135 s (9 %), sandbox exec 119 s (8 %). It enumerated 28,878 candidates, could test only 1,191 at `tRunMs` 1,574, and spent 178 sieve requests / 26,489 questions ranking a pool 24× its run budget — every one in a `plausible = 0` step. It never left phase `SEEDS` and never split its single goal. **No candidate ever passed the repro on 3 of 4.** The exception, sympy-20428, passed `repro::8813d39a` and the 320-test scoped suite, then self-terminated `complete` at 4 steps — and SWE-bench eval returned 1: its patch inserts `dmp_strip(F, f.lev)` plus an import, satisfying the engine's own issue oracle and not FAIL_TO_PASS. The scoped regression suite is *not* the cost (exec 22 s of 273 s).

## Q5 — what transfers on QuixBugs

| | llm-jev OOS | tuned OOS |
|---|---|---|
| steps / wall / $ (median of 10) | 3 / 34.0 s / $0.0008 | 6 / 78.7 s / $0.0026 |
| Jev requests per task | 3–11 (median 4.5) | 0 |
| sites · `tRunMs` · tested per search | 9–11 · 230–520 ms · 103–423 | — |
| `plausible` per solved task | 1–4 | — |
| generator samples / valid / **timeouts** | 14 / 8 / **0** | — |
| **candidates passed, by source** | mutation 19, template 6, donor 0, **llm 0** | — |

What transfers is **not** the LLM — on these 10 programs the LLM source contributed 2 enumerated candidates, 1 tested, **0 passers**. It is that a 9–11-site one-line-edit pool at `tRunMs` ≤ 520 ms is fully testable inside one round, so the first passer arrives before any ranking is needed (3 sieve requests across all ten tasks, `levenshtein` only). The mechanism already exists as `q17Needed(distinct, runsLeft, tRunMs)` (`src/synth/llm/rank.ts:57`) and `SIEVE_MAX_T_RUN_MS` (`src/synth/search/subgoal.ts:953,1134`): make the same "can I just run them all?" test gate `SIEVE` mode too, and keep per-goal pools small enough (via Q3's clustering) that it holds on the ladder.

## Q6 — the three correctness losses

| task | what the guard saw | what it committed | a general rule that catches it |
|---|---|---|---|
| `detect_cycle` (`20260922-013715-nlsygcax`) | 5 plausible, 3 clusters, **arbitrated**, `general_cand_01` noul **0.44** — above `SUSPECT_NOUL_MAX` 0.3, so the all-overfit drop never fired | template `guard_empty_break`: `if not hare.successor.successor: break` inside `while True:` → implicit `return None` | **Implicit-None exit**: the patch adds a path leaving a function whose every other exit returns a value. AST-computable, no threshold, no task name. |
| `stats` (`20260922-014311-65ul43qh`) | 5 plausible, 2 clusters, arbitrated, **no `genuine_fix` request** — decided by `probeMajorityCluster`/majority | mutation `values.remove(mid)`: makes `median([])` raise ValueError incidentally, breaks `median([2,2])`, mutates the caller's list (gold adds `if not values: raise ValueError`) | Either of: (i) **argument mutation** — the candidate mutates a parameter the pre-patch code did not (the verdict harness already diffs post-call arguments); (ii) **incidental raise** — for a `pytest.raises` goal test, a candidate adding no `raise` statement is a suspect. |
| `masked` (OOS) | not a guard acceptance: `verdicts.md` = `miss`, `replan_stop`, `plausible 0` | nothing committed | pass loss, see Q3 |


## Ranked harness changes

| # | change (mechanism) | expected OOS effect | evidence | re-fit risk |
|---|---|---|---|---|
| 1 | **Gate SIEVE/RANK on "the pool has a passer"**: run the goal test over the untested pool until a passer or the run budget is spent; rank only when `distinct > runsLeft` — extend `q17Needed` from RANK to SIEVE | −68 % Jev $ ($0.426 of $0.623), −707 requests, −236 s; no pass change | 707 requests / 64,961 questions, 99–100 % in `plausible = 0` steps; 13 of 65,076 answers ≥ 0.5 | **low** — trigger is a budget comparison, not a task property |
| 2 | **Cache Jev by `requestHash` within a run** (already computed, already in `jev.jsonl`) | −454 requests (19.5 %), ~−110 s, ~−$0.05 | 339/1,532 ladder, 115/744 SWE repeats, 0 QuixBugs | **none** |
| 3 | **Back the generator deadline off on timeout** instead of re-firing the same ~10 s | recovers 1,170 s ladder + 1,532 s SWE of zero-token sample time and $0.061 of $0.168 generator spend; likeliest source of extra ladder passers | `generator.jsonl` 82/244 and 51/130 calls `stopReason:"timeout"`, `outputTokens: 0` | **low** — a provider-latency fix seen on 2 suites |
| 4 | **Cluster goals by shared file / call chain** rather than per failing test; split a single-file multi-test goal when its sites exceed the run budget | targets the 4 `plausible = 0` losses (crossfile, six_hunks, long_chain, masked) | probe5 goal counts vs `planAfter.remaining` | **medium** — decomposition over-tunes easily; require QuixBugs to stay at 1 goal |
| 5 | **Reject a passer that adds an implicit-`None` exit, or mutates a parameter the pre-patch code did not** | catches `detect_cycle` and `stats`; 0 extra Jev requests | Q6 | **low** — AST/runtime properties, no task named |
| 6 | **Drop the degenerate families** `risk|destructive`, `risk|irreversible`, `replan|task_impossible`, and stop asking `complete|task_complete` every step | −~180 requests, ~−35 s, −$0.027 | 1 distinct answer over 51/51/39 questions; 87.7 % of `task_complete` < 0.5 | **low** — keep `risk` for destructive `run` actions outside the synth path |
| 7 | **Break the `gather_context` replan loop**: if the replan repeats the previous command with unchanged test output, force a phase escalation (SEEDS→SKETCH/WIDENED) or stop | reclaims most of crossfile's 893 s and six_hunks' 742 s, in which no patch was ever proposed | 33/39 `next_move` = `gather_context`; the two step lists | **low** |
| 8 | **Never self-terminate `complete` on an issue-oracle repro alone** — require a second, independently derived witness on SWE | keeps sympy-20428 searching instead of stopping at 4 steps with a patch that fails eval | `20260922-063746-h3qflvih`, `evalExitCode 1` | **medium** — n = 1; make it structural, do not tune a threshold to it |

Disallowed as re-fitting: anything keyed by name to `masked`, `ledger5`, `crossfile`, `six_hunks`, `sympy__sympy-16792` or the sympy repo, and any constant chosen to flip exactly one of these 22 tasks. The slice is 10 QuixBugs + 8 ladder-long + 4 sympy, so change 4 especially must be re-validated on the in-sample 28.

---

**Record archive (coordinator note).** The 44 run directories this analysis reads (`~/.jevcode/runs/<runId>/{steps,decisions,jev,generator}.jsonl`, `run.json`, `state.json`, `model_patch.diff`; 104 MB uncompressed) are outside the repository. They are archived compressed (4.1 MB) at `experiments/results/oos-2026-09-22-runs.tar.gz` (sha256 prefix 0ee44fc932b7cce0), one directory per run id; the run ids are in each `bench/results/oos-*/tasks.jsonl`. The next iteration adds a `bench --archive-runs` step so a result directory carries its own compressed run records.
