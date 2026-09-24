# Closing four caveats of the v2 head-to-head: a same-build plain baseline, and the first out-of-sample llm-jev measurement — 2026-09-22 (runs 04:00–07:26 Z)

Live measurement answering two questions the verification (`experiments/results/llm-jev-headtohead-v2.verification.md`) left open:

- **C1f** — "a same-build plain `jev-off` was **never run**"; the 19/28 baseline is `baseline-clean` @ `214bf55` (jevcode 0.2.0), eight hours before the v2 arms. Section 2 re-runs plain `jev-off` on the identical 28 tasks from the **same frozen tree** as the v2 arms.
- **C1 / C2** — "all 28 tasks are the development set … zero out-of-sample evidence exists for the mode at any build". Section 3 runs `llm-jev` and `jev-off-tuned` on 22 tasks chosen by fixed rules to exclude everything any constant, template or instance list was fitted against.
- **C1c** — both-solved medians and the per-task wall-ratio distribution are printed beside every pooled median, with a solved-and-self-terminated column.
- **C1d / C1e** — every dollar figure carries its estimated and table-rated share.

Everything ran from the frozen worktree `<repo>/.claude/worktrees/llmjev-v2` at HEAD `066816f` (`git status`: only the `node_modules` symlink untracked, unchanged before and after), jevcode **0.3.0** in every `run.json`, results written under the main checkout by absolute `--out`. No source was edited and nothing was committed. Every command was
`env -u ANTHROPIC_API_KEY node --env-file=<main>/.env node_modules/.bin/tsx src/cli/main.tsx bench --live …` (`NODE_OPTIONS=--max-old-space-size=8192` added for SWE-bench); no key appears in this document or in the logs under `/tmp/jevonly/`. Generator `openrouter z-ai/glm-5.3-flash` throughout; Jev `typesafe/jev-1.13-20260917` (wire id `jev-1.13.0`) on the `llm-jev` arms only. **Total spend $1.6752** (cap $6).

## 0. Verdict

**(a) Against a same-build plain baseline on the original 28, yes — but by less than the committed claim says.** Re-running plain `jev-off` from `066816f` gives **21/28**, not the 19/28 measured eight hours earlier on `214bf55` — so two of the nine tasks the report attributes to Jev-assisted search were the build, not the mode. Against this control `llm-jev` is 28/28 vs 21/28, paired discordance **b = 7 / c = 0** (one-sided exact sign test p = 0.0078), correct-by-verdict 26/28 vs 20/28 with **2 discordant correctness losses** (`detect_cycle`, `stats`, exactly as before), pooled median wall 63.0 s vs 246.3 s (0.256×) but **39.5 s vs 175.3 s (0.225×) restricted to the 21 both solved**, per-task ratio median 0.291 with `llm-jev` slower on 1 of 21, and $0.1441 vs $0.5875 (0.245×) — with the caveat that 78 % of the candidate's dollars are estimate or rate card against 0 % of the baseline's. The baseline is still censored (8 of 28 stopped at the wall cap, 1 errored, 19 of 28 solved-and-self-terminated, versus 0 capped and 27 of 28 self-terminated for `llm-jev`), and it still carries no generation hygiene (`maxTokens` 4096, no `reasoning`, no deadline) because that is what "plain `jev-off`" means. So the honest headline for the original 28 is **28/28 vs 21/28 (plain, same build) vs 22/28 (hygiene-tuned, same build)** — Jev-assisted search wins 7 discordant tasks on pass and loses 0, wins on wall and dollars by wide margins, and loses 2 on behavioural correctness.

**(b) Out of sample the answer is no on pass, no on wall, and no on dollars; only QuixBugs-class tasks hold up.** On 22 tasks nobody tuned against, `llm-jev` scores **13/22 [39 %, 77 %]** against tuned generator-only's **12/22 [35 %, 73 %]** — paired discordance **b = 2 / c = 1** (sign test p = 0.50, i.e. indistinguishable), correct-by-verdict 13 vs 12 with one discordant correctness loss (`masked`). The pooled all-task median wall is **1.385× the baseline's** (190.7 s vs 137.7 s) and it is only on the 11 tasks both solved that `llm-jev` is faster (37.8 s vs 108.2 s, 0.349×; per-task ratio median 0.349, `llm-jev` slower on 3 of 11) — and that both-solved set is 10 QuixBugs programs plus one ladder task, so the favourable slice is almost entirely the easy suite. Cost is **2.68× the baseline** ($0.7918 vs $0.2959), of which 88.4 % of the candidate's total is estimate or rate card. Suite by suite the picture is sharp: on the 10 out-of-sample QuixBugs programs both arms are 10/10 and 10/10 correct, and `llm-jev` wins only on wall (0.43×) and dollars (0.30×); on the 8 ladder long-tier tasks it is 3/8 vs 2/8 but 3.72× the wall and 2.87× the dollars; on the 4 unsolved SWE instances both arms score **0/4** and `llm-jev` spends 2.94× as much to get there. Nothing here refutes the in-sample result — it bounds it: **the 28/28 does not survive contact with tasks the guard constants, the two synthesis templates and the SWE instance list were not fitted against**, and outside the one-line-bug regime the extra Jev traffic (2,330 requests) buys one extra ladder task and no SWE instance for roughly three times the money and time.

## 1. What was run

| # | arm | suite | tasks | out dir | bench id | ended (Z) | spend |
|---|---|---|---|---|---|---|---|
| 1 | `jev-off` (same build) | QuixBugs | the original 10 | `bench/results/glm-jev-off-samebuild-quixbugs` | `20260922-040020-7660c5` | 04:11:04 | $0.065571 |
| 1 | `jev-off` (same build) | ladder short | 12 | `bench/results/glm-jev-off-samebuild-ladder` | `20260922-041104-6afd5e` | 04:33:44 | $0.142591 |
| 1 | `jev-off` (same build) | SWE | the original 6 | `bench/results/glm-jev-off-samebuild-swebench` | `20260922-043346-52a218` | 05:44:13 | $0.379321 |
| 2 | `llm-jev` (out of sample) | QuixBugs | 10 new | `bench/results/oos-llm-jev-quixbugs` | `20260922-054441-2ba690` | 05:46:52 | $0.007805 |
| 2 | `llm-jev` (out of sample) | ladder long | 8 | `bench/results/oos-llm-jev-ladder-long` | `20260922-054652-3cff40` | 06:31:48 | $0.395461 |
| 2 | `llm-jev` (out of sample) | SWE | 4 new | `bench/results/oos-llm-jev-swebench` | `20260922-063148-d70556` | 06:57:28 | $0.388513 |
| 3 | `jev-off-tuned` (out of sample) | QuixBugs | the same 10 | `bench/results/oos-glm-jev-off-tuned-quixbugs` | `20260922-065758-778361` | 07:03:12 | $0.025969 |
| 3 | `jev-off-tuned` (out of sample) | ladder long | the same 8 | `bench/results/oos-glm-jev-off-tuned-ladder-long` | `20260922-070313-f8f64f` | 07:15:12 | $0.137945 |
| 3 | `jev-off-tuned` (out of sample) | SWE | the same 4 | `bench/results/oos-glm-jev-off-tuned-swebench` | `20260922-071513-a0a12c` | 07:25:56 | $0.131987 |

Arms ran strictly one after another, suites sequentially within an arm (QuixBugs → ladder → SWE), each detached under `nohup` with a log under `/tmp/jevonly/arm{1,2,3}-<suite>.log` ending in an `exit 0` line. Nothing else ran on the machine during a bench, with one disclosed exception: the two verdict scripts for arm 1 overlapped the **first ~30 s** of arm 2's QuixBugs suite. That suite's own recorded `loadavg` runs 4.4–53.3 (the `llm-jev` verify lanes' own load), so the overlap is inside the arm's self-generated noise.

### 1.1 Exact commands

```
cd <repo>/.claude/worktrees/llmjev-v2

# arm 1 — same-build plain baseline on the original 28
env -u ANTHROPIC_API_KEY node --env-file=<main>/.env node_modules/.bin/tsx src/cli/main.tsx bench \
  --suite quixbugs --conditions jev-off --live \
  --task-id bitcount,bucketsort,detect_cycle,find_in_sorted,gcd,kth,lis,mergesort,shortest_path_length,wrap \
  --concurrency 4 --max-steps 12 --max-wall 8m --spend-cap 0.6 --task-spend-cap 0.06 \
  --out <main>/bench/results/glm-jev-off-samebuild-quixbugs
env -u ANTHROPIC_API_KEY node --env-file=<main>/.env node_modules/.bin/tsx src/cli/main.tsx bench \
  --suite ladder --conditions jev-off --live --tasks 12 \
  --concurrency 3 --max-steps 25 --max-wall 12m --spend-cap 1.0 --task-spend-cap 0.1 \
  --out <main>/bench/results/glm-jev-off-samebuild-ladder
env -u ANTHROPIC_API_KEY NODE_OPTIONS=--max-old-space-size=8192 node --env-file=<main>/.env node_modules/.bin/tsx src/cli/main.tsx bench \
  --suite swebench --conditions jev-off --live \
  --task-id sympy__sympy-15345,sympy__sympy-17139,sympy__sympy-19954,sympy__sympy-11618,django__django-15128,django__django-15315 \
  --concurrency 2 --max-steps 25 --max-wall 25m --spend-cap 1.2 --task-spend-cap 0.25 \
  --out <main>/bench/results/glm-jev-off-samebuild-swebench

# arms 2 and 3 — out of sample; <ARM> is llm-jev then jev-off-tuned, <OUT> oos-llm-jev-* then oos-glm-jev-off-tuned-*
env -u ANTHROPIC_API_KEY node --env-file=<main>/.env node_modules/.bin/tsx src/cli/main.tsx bench \
  --suite quixbugs --conditions <ARM> --live \
  --task-id breadth_first_search,get_factors,hanoi,is_valid_parenthesization,knapsack,lcs_length,levenshtein,next_palindrome,pascal,powerset \
  --concurrency 4 --max-steps 12 --max-wall 8m --spend-cap 0.6 --task-spend-cap 0.06 \
  --out <main>/bench/results/<OUT>quixbugs
env -u ANTHROPIC_API_KEY node --env-file=<main>/.env node_modules/.bin/tsx src/cli/main.tsx bench \
  --suite ladder --conditions <ARM> --live \
  --task-id crossfile,import_and_guard,ledger5,long_chain,masked,regress_trap,shared_frame,six_hunks \
  --concurrency 2 --max-steps 30 --max-wall 15m --spend-cap 1.5 --task-spend-cap 0.15 \
  --out <main>/bench/results/<OUT>ladder-long
env -u ANTHROPIC_API_KEY NODE_OPTIONS=--max-old-space-size=8192 node --env-file=<main>/.env node_modules/.bin/tsx src/cli/main.tsx bench \
  --suite swebench --conditions <ARM> --live \
  --task-id sympy__sympy-13798,sympy__sympy-16792,sympy__sympy-20428,sympy__sympy-22080 \
  --concurrency 2 --max-steps 25 --max-wall 25m --spend-cap 1.2 --task-spend-cap 0.25 \
  --out <main>/bench/results/<OUT>swebench
```

Verdicts, then the head-to-head tool:

```
node_modules/.bin/tsx experiments/inspect/quixbugs-verdicts.mts bench/results/{glm-jev-off-samebuild-quixbugs,oos-llm-jev-quixbugs,oos-glm-jev-off-tuned-quixbugs}
node_modules/.bin/tsx experiments/inspect/ladder-verdicts.mts   bench/results/{glm-jev-off-samebuild-ladder,oos-llm-jev-ladder-long,oos-glm-jev-off-tuned-ladder-long}
node_modules/.bin/tsx experiments/llm-jev/headtohead.mts bench/results/glm-jev-off-samebuild-{quixbugs,ladder,swebench} bench/results/llm-jev-v2-{quixbugs,ladder,swebench} \
  --candidate llm-jev --baseline jev-off --out experiments/results/llm-jev-headtohead-v2.samebuild.tool.md
node_modules/.bin/tsx experiments/llm-jev/headtohead.mts bench/results/oos-glm-jev-off-tuned-{quixbugs,ladder-long,swebench} bench/results/oos-llm-jev-{quixbugs,ladder-long,swebench} \
  --candidate llm-jev --baseline jev-off-tuned --out experiments/results/llm-jev-headtohead-v2.oos.tool.md
```

The two tool outputs are committed beside this file as `llm-jev-headtohead-v2.samebuild.tool.md` and `llm-jev-headtohead-v2.oos.tool.md`; every per-task row is there. `verdicts.md` sits in each new results dir. Both verdict scripts fell back to `model_patch.diff` where no `jev-only/` workspace exists, as designed.

### 1.2 The out-of-sample task lists, and the rule that produced them

**QuixBugs (10).** Alphabetical order over the 30 programs not in the original 10, skipping every name JEV-ONLY-DESIGN §7's in-sample disclosure lists, then the first 10. Skipped as in-sample: the constant-tuning programs `depth_first_search, longest_common_subsequence, reverse_linked_list, shunting_yard, sqrt` (plus `bitcount, detect_cycle, wrap`, already in the original set) **and** the ten programs whose gold fixes are quoted verbatim in the Q7 `edit_class` option wording (`jev-only-audit.md` §3.2, `src/synth/sketch/questions.ts:34-39`): `find_first_in_sorted, flatten, kheapsort, max_sublist_sum, minimum_spanning_tree, next_permutation, possible_change` (plus `bucketsort, find_in_sorted, gcd`, already in the original set). 18 programs remained eligible; the first 10 are

> `breadth_first_search, get_factors, hanoi, is_valid_parenthesization, knapsack, lcs_length, levenshtein, next_palindrome, pascal, powerset`

None is among the v1/v2 fix-round motivating cases (`wrap, textstats, shipping, detect_cycle, stats, grades, units, calendar_utils`).

**Ladder long tier (8).** The whole tier: `crossfile, import_and_guard, ledger5, long_chain, masked, regress_trap, shared_frame, six_hunks`. None is a fix-round motivating case and none appears in §7's constant list. Two honest qualifications: `masked` is named in the `guard.ts` fix brief ("the fix brief's 0.7 would let `masked` 3b through again") and `ledger5` was scored in the jev-only long-tier rungs, so these two are *inspected* if not *fitted*; both are on the losing and winning side respectively, and dropping them leaves `llm-jev` 2/6 vs 1/6.

**SWE-bench Verified (4).** The first four instances in `bench/data/swebench-verified-30.json` order that are **not** among the 9 issue-oracle-VALID instances (`psf__requests-2931, sympy__sympy-12096, django__django-15315, sympy__sympy-15345, sympy__sympy-17139, sympy__sympy-19954, sympy__sympy-11618, django__django-15128, django__django-15563`) and **not** solved by any arm in any committed run:

> `sympy__sympy-13798, sympy__sympy-16792, sympy__sympy-20428, sympy__sympy-22080`

All four are sympy — an artefact of the fixed rule, since positions 1–5 of the file are all oracle-valid sympy instances and position 12 onward is where the first eligible non-sympy instance would appear. This is a repo-monoculture slice and should not be read as a SWE-bench-Verified estimate.

## 2. Question (a): `llm-jev` v2 against the same-build plain baseline, original 28

`llm-jev` figures are the committed `bench/results/llm-jev-v2-*` records, unchanged; only the baseline is new.

### 2.1 Pooled (28 paired tasks)

| metric | `llm-jev` (v2) | `jev-off` same build `066816f` | for reference: `jev-off` @ `214bf55` | for reference: `jev-off-tuned` same build |
|---|---|---|---|---|
| pass | **28/28** (Wilson [88 %, 100 %]) | **21/28** ([57 %, 87 %]) | 19/28 ([49 %, 82 %]) | 22/28 |
| correct-by-verdict (SWE = pass, not measured) | **26/28** ([77 %, 98 %]) | **20/28** ([53 %, 85 %]) | 19/28 | 20/28 |
| discordant pairs, pass (b = candidate wins / c = baseline wins) | — | **b = 7, c = 0**, both 21, neither 0; sign p = **0.0078** | b = 9, c = 0 | b = 6, c = 0 |
| discordant pairs, correctness | — | **b = 8, c = 2** (losses `detect_cycle`, `stats`); sign p = 0.0547 | b = 9, c = 2 | b = 6, c = 2 |
| median wall, all tasks | 63.0 s | 246.3 s (**0.256×**) | 390.8 s (0.161×) | 111.4 s |
| median wall, **both solved** (n) | 39.5 s (n = 21) | 175.3 s (**0.225×**) | 111.8 s (n = 19, 0.314×) | — |
| per-task wall ratio, both solved | min 0.016 · p25 0.104 · **median 0.291** · p75 0.494 · max 1.745; slower on **1/21** | — | median 0.317, slower on 3/19 | — |
| $ total | **$0.144138** | **$0.587483** (0.245×) | $0.506224 | $0.242607 |
| … of which not provider-reported | $0.112487 = **78.0 %** (est. generator $0.013914 = 30.5 % of generator; Jev $0.098573 all `costBasis: "table"`) | **$0 = 0 %** (383/383 provider rows) | $0 = 0 % | $0.027478 estimated |
| Jev requests | 482 | 0 | 0 | 0 |
| solved **and** self-terminated | **27/28** | 19/28 | — | — |
| stopped at the wall cap / at `max_steps` / error | 0 / 0 / 0 | **8** / 0 / 1 | 10 / 0 / 0 | 0 / 7 / 0 |

### 2.2 Per suite

| suite | arm | pass | Wilson | correct | overfit | steps-to-solve median | wall median all / both-solved | per-task ratio (both solved) | $ total | $ per solved | Jev req |
|---|---|---|---|---|---|---|---|---|---|---|---|
| QuixBugs 10 | `llm-jev` | **10/10** | [72 %, 100 %] | 9 | 1 | 3 | 36.7 s / 35.1 s | median 0.494, slower 1/8 | $0.026289 | $0.0026 | 105 |
| QuixBugs 10 | `jev-off` same build | 8/10 | [49 %, 94 %] | 8 | 0 | 5 | 60.7 s / 59.9 s | — | $0.065571 | $0.0082 | 0 |
| ladder short 12 | `llm-jev` | **12/12** | [76 %, 100 %] | 11 | 1 | 2 | 39.5 s / 58.4 s | median 0.107, slower 0/11 | $0.049762 | $0.0041 | 203 |
| ladder short 12 | `jev-off` same build | 11/12 | [65 %, 99 %] | 10 | 1 (`calendar_utils`, strong) | 9 | 200.5 s / 200.5 s | — | $0.142591 | $0.0130 | 0 |
| SWE 6 | `llm-jev` | **6/6** | [61 %, 100 %] | 6 (= pass) | 0 | 2 | 133.7 s / 23.8 s | 0.016, 0.174 (n = 2) | $0.068087 | $0.0113 | 174 |
| SWE 6 | `jev-off` same build | 2/6 | [10 %, 70 %] | 2 (= pass) | 0 | 19 | 1500.0 s / 781.1 s | — | $0.379321 | $0.1897 | 0 |

Paired discordance per suite: QuixBugs b = 2 / c = 0 (p = 0.250); ladder b = 1 / c = 0; SWE b = 4 / c = 0 (p = 0.063). Only the SWE suite clears its pre-registered criterion-1 bar; QuixBugs and ladder fail it against this stronger baseline, and QuixBugs now also fails criterion 3 (median wall 0.604× against a ≤ 0.5× bar) because the same-build baseline is so much faster than the `214bf55` one.

### 2.3 What changed between builds, and where

The same-build baseline is **+2 net** over `214bf55` (19 → 21), and the change is not monotone — six of 28 tasks flip, four of them to pass:

| task | at `214bf55` | at `066816f` |
|---|---|---|
| QuixBugs `mergesort` | fail, `wall_time`, 480 s | **pass**, `generator_done`, 175 s |
| ladder `account` | fail, `max_steps`, 600 s | **pass**, `generator_done`, 457 s |
| ladder `calendar_utils` | fail, `wall_time`, 720 s | **pass**, `generator_done`, 178 s |
| ladder `table` | fail, `wall_time`, 720 s | **pass**, `generator_done`, 334 s |
| ladder `grades` | pass, `generator_done`, 319 s | **fail**, `wall_time`, 720 s |
| SWE `sympy__sympy-11618` | pass, `generator_done`, 393 s | **fail**, `error`, 858 s |

Wall collapsed with it: pooled median 390.8 s → 246.3 s, capped runs 10 → 8. Cost rose ($0.506 → $0.587) because more runs got far enough to spend. Six flips of 28 on a re-run of the *same arm* is also a direct run-to-run noise estimate for this baseline — roughly ±2 tasks — which is the same order as the discordance the out-of-sample comparison in section 3 turns on. This is the honest size of the "build and noise alone" effect on the plain arm, and it is why the bare "28/28 vs 19/28" overstates the mode's contribution by two tasks.

### 2.4 Correctness losses are unchanged

`llm-jev` still loses `detect_cycle` (overfit: returns `None` on even-length acyclic chains where the baseline is gold-identical) and `stats` (strong overfit: `values.remove(mid)` mutates the caller's list and breaks `median([2,2])`, where the baseline is gold-identical). The new baseline introduces one overfit of its own, ladder `calendar_utils` (strong), which `llm-jev` gets gold-identical — so the correctness discordance is **b = 8 / c = 2**, not 9/2. As the verification notes, ladder `units` is labelled `equivalent` by an oracle that is the engine's own guard probe and is blind to decimal/scientific string inputs, so all ladder correctness counts here carry that known upward bias for **both** arms.

## 3. Question (b): out of sample, `llm-jev` against tuned generator-only

### 3.1 Pooled (22 paired tasks, none used to tune anything)

| metric | `llm-jev` | `jev-off-tuned` |
|---|---|---|
| pass | **13/22** (Wilson [39 %, 77 %]) | **12/22** ([35 %, 73 %]) |
| correct-by-verdict (SWE = pass) | **13/22** | **12/22** |
| discordant pairs, pass | **b = 2, c = 1**, both 11, neither 8; sign p = **0.500** | — |
| discordant pairs, correctness | **b = 2, c = 1** (loss: `masked`) | — |
| median wall, all tasks | 190.7 s | 137.7 s (**1.385× against**) |
| median wall, **both solved** (n = 11) | **37.8 s** | 108.2 s (**0.349×**) |
| per-task wall ratio, both solved | min 0.175 · p25 0.232 · **median 0.349** · p75 1.003 · max 3.035; slower on **3/11** | — |
| $ total | **$0.791779** | **$0.295901** (candidate 2.68× the baseline) |
| … of which not provider-reported | $0.699742 = **88.4 %** (est. generator $0.076436 = 45.4 % of generator; Jev $0.623306 all table-rated) | $0.013829 = 4.7 % estimated |
| Jev requests | **2,330** | 0 |
| solved **and** self-terminated | 13/22 | 8/22 |
| stopped at the wall cap / `max_steps` / `max_replans` / `replan_stop` | 1 / 0 / 3 / 4 | 0 / **14** / 0 / 0 |

The censoring is asymmetric and runs the other way from section 2: the tuned arm is bounded by the **step** budget (14 of 22 records end at `max_steps` 30 or 25, none at the wall cap), while `llm-jev` is bounded by **replans and wall** (7 of 22). Both walls are therefore right-censored, in different units; the both-solved row is the only comparison free of it, and it covers 11 tasks of which 10 are QuixBugs.

### 3.2 Per suite

| suite | arm | pass | Wilson | correct | overfit | steps-to-solve median | wall median all / both-solved | per-task ratio (both solved) | $ total | $ per task | $ per solved | Jev req |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| QuixBugs 10 (new) | `llm-jev` | 10/10 | [72 %, 100 %] | 10 (8 gold-identical + 2 equivalent) | **0** | 3 | 34.0 s / 34.0 s | min 0.175 · median 0.282 · max 1.910; slower 2/10 | $0.007805 | $0.0008 | $0.0008 | 54 |
| QuixBugs 10 (new) | `jev-off-tuned` | 10/10 | [72 %, 100 %] | 10 (9 gold-identical + 1 equivalent) | 0 | 6 | 78.7 s / 78.7 s | — | $0.025969 | $0.0026 | $0.0026 | 0 |
| ladder long 8 | `llm-jev` | **3/8** | [14 %, 69 %] | 3 (1 gold-identical + 2 equivalent) | 0 | 10 | 512.1 s / 449.3 s | 3.035 (n = 1) | $0.395461 | $0.0494 | $0.1318 | 1,532 |
| ladder long 8 | `jev-off-tuned` | 2/8 | [7 %, 59 %] | 2 (2 gold-identical) | 0 | 23 | 137.7 s / 148.0 s | — | $0.137945 | $0.0172 | $0.0690 | 0 |
| SWE 4 (new) | `llm-jev` | **0/4** | [0 %, 49 %] | 0 | 0 | n/a | 322.7 s / — | — | $0.388513 | $0.0971 | n/a | 744 |
| SWE 4 (new) | `jev-off-tuned` | **0/4** | [0 %, 49 %] | 0 | 0 | n/a | 221.9 s / — | — | $0.131987 | $0.0330 | n/a | 0 |

Per-suite discordance: QuixBugs b = 0 / c = 0 (10 both); ladder b = 2 (`import_and_guard`, `ledger5`) / c = 1 (`masked`) / both 1 (`shared_frame`) / neither 4; SWE b = 0 / c = 0 / neither 4.

### 3.3 The three suites tell three different stories

**QuixBugs, out of sample: a clean win on efficiency, none on capability.** Both arms solve all ten, both are 10/10 correct, and **neither produces a single overfit** — the first time the guard's thresholds have been exercised on programs they were not fitted against, and they hold. `llm-jev` gets there in a median 3 steps and 34 s for $0.0008 per task against 6 steps, 79 s and $0.0026; it is slower on 2 of 10 (`levenshtein` 1.91×, `knapsack` 1.00×). This is the regime the mode was built for and it generalises within it.

**Ladder long tier: one extra task for 2.9× the money and 3.7× the wall.** `llm-jev` solves `import_and_guard` (6 steps, 3 m 10 s) and `ledger5` (14 steps, 8 m 30 s) which the tuned arm misses at `max_steps` 30, and both arms solve `shared_frame`; the tuned arm solves `masked`, which `llm-jev` misses after 12 steps and 8 m 32 s. Four tasks (`crossfile`, `long_chain`, `regress_trap`, `six_hunks`) defeat both. `llm-jev` spent 1,532 Jev requests and $0.3955 against $0.1379. Its stop reasons on the five misses are `replan_stop` (3) and `max_replans` (2) — it is exhausting its planning budget, not its wall, on tasks whose planted defects span 2–6 coupled hunks. For reference the jev-only final tree scored 2/8 on this tier, so the LLM-plus-Jev combination adds one task over no-generator search here.

**SWE, out of sample: both arms score zero.** `llm-jev` ends `max_replans` / `complete` / `wall_time` / `replan_stop` on the four instances and produced an empty patch on 3 of 4; `jev-off-tuned` ran all four to `max_steps` 25 and produced empty patches on 2 of 4. `sympy__sympy-16792` consumed $0.2178 and 432 Jev requests before hitting the 25-minute cap. The 6/6 on the original SWE set was six of the nine issue-oracle-VALID instances, four of which the synthesizer had already solved and two of which have a named capability shipped for them in `src/synth/templates/` (`stdlib.ts` cites sympy-11618, `wrap2.ts` cites sympy-19954); on four instances with no oracle and no fitted capability the mode reaches nothing. This is the single most important number in this document: **the SWE result does not generalise at all in its present form.**

## 4. What this does and does not settle

Settled: C1f is closed — the same-build plain control exists, it is 21/28, and the report's lead-in must read "vs 21/28 (plain, same build) / 22/28 (tuned, same build)", with 19/28 kept only as the `214bf55` historical figure. C1c is closed — both-solved medians and ratio distributions are printed above for both comparisons, and the solved-and-self-terminated column shows the direction of the censoring in each. C1d/C1e are labelled everywhere: 78 % of the candidate's in-sample dollars and 88 % of its out-of-sample dollars are estimate or rate card, against 0 % and 4.7 % of the baselines'.

Not settled, and not claimed: n is still small (28 in-sample, 22 out of sample, against §10.3's 90 paired tasks and 4 arms); no repeat run and no `LLM_GRACE_MS=0` run exists for any of it; `llm-sieve` still throws `ConfigError`, so criterion 5's attribution question — how much of this is Jev rather than shadow-lane verification — remains unanswered; the ladder correctness oracle is still `perturb.ts`'s `LADDER_HARNESS`, i.e. the engine's own guard probe, and is still blind to the `units`-class divergence; SWE "correctness" is still defined as pass in `src/bench/headtohead.ts:92`; the SWE out-of-sample slice is four sympy instances, not a Verified estimate; and the SWE evaluator remains this repo's non-Docker local-venv replication of `eval.sh`. Two of the eight ladder long-tier tasks (`masked`, `ledger5`) have been inspected before even though no constant is keyed to them.
