# OOS iteration 1, measured: a fresh 18-task slice, the in-sample 28 as a regression arm, and the blocker that had to be switched off first — 2026-09-22 (runs 10:24–13:00 Z)

Everything below ran from the frozen worktree `.claude/worktrees/iter1-clean` at HEAD **`751e3bf`** (`git status`: only the `node_modules` symlink untracked), `npm run build` first, jevcode **0.4.0**, generator `openrouter z-ai/glm-5.3-flash`, Jev `jev-1.13.0`. Every live command was
`env -u ANTHROPIC_API_KEY [JEVCODE_WARM=off] node --env-file=<main>/.env bin/jevcode.js bench --live …`; no key appears here or in the logs under `/tmp/iter1/` (every tail filtered through `grep -vE 'sk-|api[_-]?key'`, nothing matched). Results and their archived run records are written into this worktree and committed on `bench-iter1`. **Total spend $0.5798** of a $6 cap ($0.5766 bench + $0.0032 Ring 2). Script output: `llm-jev-iter1.tool.md`.

## 0. Verdict

**(0) The measurement could not be taken as shipped.** At the default configuration `llm-jev` at `751e3bf` **never completes a synthesis step**: the SIEVE runner dispatches its batch onto the verification lanes, `0 tested on 8 lanes (nothing ran)`, and the run burns its whole wall cap in step 1. The first fresh-slice QuixBugs arm produced five records at `wall_time` with **0–1 steps and 0 candidates tested**, and three more runs wedged at **0 % CPU with no child processes for 59 minutes** until killed (kept at `bench/results/iter1-fresh-llm-jev-quixbugs-warmON-aborted`). A five-point $0 offline A/B (§3) pins it on the **warm verification plane** (`src/synth/warm/`, commits `7c99ce0` + `6cd0e76`, HARNESS-NEXT wave S1 M6) — a change that landed on main between `066816f` and `751e3bf` and is **not** one of the eight OOS iteration-1 changes. `JEVCODE_WARM=off`, the switch the module documents as "forces today's behaviour", restores it and is what the whole measurement below uses. **This is the finding to act on before anything else in this document.**

**(a) On a fresh 18-task slice, iteration 1 beats tuned generator-only on pass — and for the first time the win is outside QuixBugs.** `llm-jev` **12/18** (Wilson [44 %, 84 %]) against `jev-off-tuned` **9/18** ([29 %, 71 %]); discordance **b = 4 / c = 1**, one-sided exact sign test **p = 0.1875**. The four wins are the whole of the ladder **long-2** tier it solves (`deadline_queue`, `dep_order`, `hunk_merge`, `token_bucket`) — a tier authored blind and built so that *no single hunk of any gold diff helps* and seven of eighteen hunks leave a strictly worse tree. `jev-off-tuned` scores **0/6** there, ending every task at `max_steps` 30. The one loss is SWE `django__django-16100`. Correct-by-verdict 11/18 vs 9/18. Cost is a wash ($0.2517 vs $0.2435, 1.03×) and the pooled median wall is 60.9 s vs 71.1 s — but on the 8 both solved (all QuixBugs) `llm-jev` is **slower**, 26.0 s vs 19.7 s (1.32×; per-task ratio median 1.406, slower on 5 of 8). Compared with the previous OOS slice this is a real move: 3/8 → 4/6 on a *harder* ladder tier, and Jev traffic per SWE instance down from 34–432 requests to 30–33.

**(b) The in-sample 28 lose exactly one task: `django__django-15128`.** `llm-jev` is **27/28** against the frozen `066816f` reference of 28/28 (and the same-build plain 21/28 / tuned 22/28). The regression ends `replan_stop` at 7 steps / 129 s, i.e. it is **change 7's forced-escalation stop firing on a task the old build ground out**. Everything else holds and gets cheaper: $0.0783 against $0.1441 (**0.54×**), 394 Jev requests against 482 (0.82×), median wall 75.6 s against 63.0 s (1.20× — slower). Correctness is unchanged, which is the second bad news: **`detect_cycle` is an overfit again and `stats` is a weak overfit again**, so change 5 did not do the job it was ranked for.

**(c) Four of the eight predictions hold, three fail, one is untestable here.** Change 1 holds on QuixBugs (0 candidates ranked) and the ladder (ranked = 7 % of tested) and **fails completely on repositories** (SWE: 6,960 ranked against **20 tested**). Change 2 holds and is now countable (`jevCacheHits` = `cached` rows exactly, 313/313 and 68/68). Change 3 **fails**: zero-token timeouts are 135 of 290 samples (46.6 %) and 3,501 s of 5,506 sample-seconds (63.6 %) — worse than the 34–39 % of calls it was meant to fix. Change 4 holds (QuixBugs stays one goal on all 18 runs; no site-budget split ever fired). Change 5 **fails** on its two named cases. Change 6 holds (`task_complete` asked 15×/32× against 127; the degenerate families are gone). Change 7 holds mechanically and costs a task. Change 8 has no counter-example in this slice.

## 1. What was run

| # | arm | suite | tasks | out dir | bench id | spend |
|---|---|---|---|---|---|---|
| A1 | `llm-jev` | QuixBugs | 8 fresh | `bench/results/iter1-fresh-llm-jev-quixbugs` | `20260922-113945-5ec834` | $0.004924 |
| A2 | `llm-jev` | ladder long-2 | 6 | `bench/results/iter1-fresh-llm-jev-ladder-long2` | `20260922-114107-4a7c62` | $0.199485 |
| A3 | `llm-jev` | SWE | 4 fresh | `bench/results/iter1-fresh-llm-jev-swebench` | `20260922-120635-f27f08` | $0.047259 |
| A4 | `jev-off-tuned` | QuixBugs | the same 8 | `bench/results/iter1-fresh-jev-off-tuned-quixbugs` | `20260922-121043-53ed84` | $0.024147 |
| A5 | `jev-off-tuned` | ladder long-2 | the same 6 | `bench/results/iter1-fresh-jev-off-tuned-ladder-long2` | `20260922-121150-a97b61` | $0.111154 |
| A6 | `jev-off-tuned` | SWE | the same 4 | `bench/results/iter1-fresh-jev-off-tuned-swebench` | `20260922-122011-715645` | $0.108173 |
| B1 | `llm-jev` | QuixBugs | the original 10 | `bench/results/iter1-insample-llm-jev-quixbugs` | `20260922-122717-c86e58` | $0.015505 |
| B2 | `llm-jev` | ladder short | the original 12 | `bench/results/iter1-insample-llm-jev-ladder` | `20260922-123253-d651ed` | $0.019567 |
| B3 | `llm-jev` | SWE | the original 6 | `bench/results/iter1-insample-llm-jev-swebench` | `20260922-124000-be188b` | $0.043206 |
| — | `llm-jev`, **default (warm on)**, aborted | QuixBugs | 5 of 8, 3 wedged | `bench/results/iter1-fresh-llm-jev-quixbugs-warmON-aborted` | `20260922-102420-…` | $0.003165 |

Arms ran strictly one after another, suites sequentially inside an arm, each detached under `nohup` with a log in `/tmp/iter1/` ending `ALLDONE exit 0`. Every results directory carries its own `runs/<runId>/*.gz` (`--archive-runs`; 168 KB – 1.2 MB per directory) and its `verdicts.md`.

**Disclosure.** A peer session's own `llm-jev` bench (`/private/tmp/mainchk_prov/bin/jevcode.js`, 3 runs) was on the machine from 10:11 to 11:23 Z — wedged by the same warm-plane fault, at 0 % CPU with no children. It overlaps the aborted warm-on arm and the first minutes of the A/B, neither of which contributes a timing number to §4–§6. Recorded `loadavg` at the start of every arm-A/arm-B run is 0.9–4.2.

### 1.1 Exact commands

```
cd /Users/prateekjannu/Documents/vscode/JevCode/.claude/worktrees/iter1-clean   # git worktree add --detach … 751e3bf; ln -s <main>/node_modules .; npm run build

# <ARM> = llm-jev then jev-off-tuned; <OUT> = iter1-fresh-llm-jev-* then iter1-fresh-jev-off-tuned-*
env -u ANTHROPIC_API_KEY JEVCODE_WARM=off node --env-file=<main>/.env bin/jevcode.js bench \
  --suite quixbugs --conditions <ARM> --live \
  --task-id quicksort,rpn_eval,shortest_path_lengths,shortest_paths,sieve,subsequences,to_base,topological_ordering \
  --concurrency 4 --max-steps 12 --max-wall 8m --spend-cap 0.5 --task-spend-cap 0.06 \
  --archive-runs --out <wt>/bench/results/<OUT>quixbugs
env -u ANTHROPIC_API_KEY JEVCODE_WARM=off node --env-file=<main>/.env bin/jevcode.js bench \
  --suite ladder --conditions <ARM> --live \
  --task-id csv_schema,deadline_queue,dep_order,hunk_merge,route_match,token_bucket \
  --concurrency 2 --max-steps 30 --max-wall 15m --spend-cap 1.2 --task-spend-cap 0.18 \
  --archive-runs --out <wt>/bench/results/<OUT>ladder-long2
env -u ANTHROPIC_API_KEY JEVCODE_WARM=off NODE_OPTIONS=--max-old-space-size=8192 node --env-file=<main>/.env bin/jevcode.js bench \
  --suite swebench --conditions <ARM> --live \
  --task-id django__django-14787,django__django-16100,django__django-14725,django__django-15375 \
  --concurrency 2 --max-steps 25 --max-wall 25m --spend-cap 1.0 --task-spend-cap 0.25 \
  --archive-runs --out <wt>/bench/results/<OUT>swebench

# arm B — the in-sample 28, the v2 report's own limits and concurrency
… --suite quixbugs --conditions llm-jev --live --task-id bitcount,bucketsort,detect_cycle,find_in_sorted,gcd,kth,lis,mergesort,shortest_path_length,wrap \
  --concurrency 4 --max-steps 12 --max-wall 8m --spend-cap 0.8 --task-spend-cap 0.06 --archive-runs --out …/iter1-insample-llm-jev-quixbugs
… --suite ladder   --conditions llm-jev --live --tasks 12 --concurrency 3 --max-steps 25 --max-wall 12m --spend-cap 1.2 --task-spend-cap 0.1  --archive-runs --out …/iter1-insample-llm-jev-ladder
… --suite swebench --conditions llm-jev --live --task-id sympy__sympy-15345,sympy__sympy-17139,sympy__sympy-19954,sympy__sympy-11618,django__django-15128,django__django-15315 \
  --concurrency 2 --max-steps 25 --max-wall 25m --spend-cap 1.5 --task-spend-cap 0.25 --archive-runs --out …/iter1-insample-llm-jev-swebench

# verdicts (one results dir per call — the script uses only the last positional argument)
node_modules/.bin/tsx experiments/inspect/quixbugs-verdicts.mts bench/results/<dir>
node_modules/.bin/tsx experiments/inspect/ladder-verdicts.mts   bench/results/<dir>
node_modules/.bin/tsx experiments/llm-jev/headtohead.mts bench/results/iter1-fresh-{jev-off-tuned,llm-jev}-{quixbugs,ladder-long2,swebench} \
  --candidate llm-jev --baseline jev-off-tuned --out experiments/results/llm-jev-iter1.tool.md   # §1 of the tool file
env -u ANTHROPIC_API_KEY JEVCODE_WARM=off node --env-file=<main>/.env node_modules/.bin/tsx experiments/harness-next/quick.mts --ring 1
env -u ANTHROPIC_API_KEY JEVCODE_WARM=off node --env-file=<main>/.env node_modules/.bin/tsx experiments/harness-next/quick.mts --ring 2 --live --spend-cap 0.05
```

## 2. The task lists, and the rules that produced them

**QuixBugs (8).** Alphabetical over the 40 programs; drop the original 10 (30 left); drop JEV-ONLY-DESIGN §7's constant-tuning names (`depth_first_search, longest_common_subsequence, reverse_linked_list, shunting_yard, sqrt`) and the ten programs whose gold fix is quoted in the Q7 `edit_class` wording (`find_first_in_sorted, flatten, kheapsort, max_sublist_sum, minimum_spanning_tree, next_permutation, possible_change`, the other three already in the original 10) → **18 eligible**, whose first ten reproduce the previous OOS slice exactly (verified by script). The remaining eight are

> `quicksort, rpn_eval, shortest_path_lengths, shortest_paths, sieve, subsequences, to_base, topological_ordering`

**Ladder long-2 (6).** The whole new tier, authored blind on 2026-09-22 and never run live before: `csv_schema, deadline_queue, dep_order, hunk_merge, route_match, token_bucket`.

**SWE-bench Verified (4).** The first four instances in `bench/data/swebench-verified-30.json` order that are (i) not sympy, (ii) not among the nine issue-oracle-VALID instances, (iii) never passed by any arm in any committed `bench/results/*/tasks.jsonl`. Positions 11, 14, 15, 17 survive (12 and 18 are oracle-valid; 13 was passed by `live-swebench-30/jev-on`, 16 by both arms of that run):

> `django__django-14787, django__django-16100, django__django-14725, django__django-15375`

This is a django monoculture, as the sympy slice before it was a sympy one, and is not a Verified estimate.

## 3. The blocker: the warm verification plane

Offline (`bench` with no `--live`, the stub decider), one task, `--concurrency 1`, same machine, nothing else running:

| build / runner | stopReason | wall | steps | `candidatesTested` |
|---|---|---|---|---|
| `066816f` — tsx (the previous measurement's build) | `max_steps` | 107.4 s | 6 | **2,896** |
| `168a599` — tsx (iteration 1, before the ten review fixes) | `wall_time` | 180.1 s | **0** | **0** |
| `751e3bf` — tsx | `wall_time` | 180.1 s | **0** | **0** |
| `751e3bf` — `bin/jevcode.js` (the built bundle) | `wall_time` | 180.1 s | **0** | **0** |
| `751e3bf` — `bin/jevcode.js`, **`JEVCODE_WARM=off`** | `max_steps` | **80.8 s** | **6** | **2,180** |

So it is not the bundle, not the network, not concurrency, not machine load, and not the ten review fixes. The step-1 line reads

```
synth verify: g1: 0 tested on 8 lanes (nothing ran); runs left 1488, test wall left 0 s;
  warm 4/8, screen 540 ms, 4 fallbacks, 4 restarts; aborted;
  lane failure: LaneError: `git checkout -- . && git clean -fdq` failed (exit null, killed: wall_time)
```

— four warm workers restarted, four fell back to cold, no lane ever produced an outcome, and the batch held the step until the run's wall cap killed the lane's own git reset. In three of eight live runs the wall cap could not fire at all: the bench process sat at 0 % CPU with no child processes for 59 minutes. `timing.execMs` is **0** on every one of those records while `wallMs` is the full cap. `warmModeFor` defaults the plane **on** for `quixbugs` and `pytest` runners, so every Python suite of this repository is affected; `JEVCODE_WARM=off` is the documented escape and is set on every arm below.

## 4. Question (a): the fresh 18

### 4.1 Pooled (18 paired tasks, nothing tuned against them)

| metric | `llm-jev` | `jev-off-tuned` |
|---|---|---|
| pass | **12/18** (Wilson [43.7 %, 83.7 %]) | **9/18** ([29.0 %, 71.0 %]) |
| correct-by-verdict (SWE = pass) | **11/18** | **9/18** |
| discordant pairs, pass | **b = 4** (`deadline_queue, dep_order, hunk_merge, token_bucket`) **/ c = 1** (`django__django-16100`), both 8, neither 5; sign p = **0.1875** | — |
| median wall, all tasks | **60.9 s** | 71.1 s (0.86×) |
| median wall, **both solved** (n = 8, all QuixBugs) | 26.0 s | **19.7 s** (1.32× against) |
| per-task wall ratio, both solved | min 0.486 · **median 1.406** · max 5.756; `llm-jev` slower on **5/8** | — |
| $ total | $0.251668 | $0.243474 (1.03×) |
| … generator / Jev | $0.101685 / $0.149982 (all `costBasis: "table"`) | $0.243474 / $0 |
| Jev requests / questions | **1,086 / 13,541** | 0 / 0 |
| `jevCacheHits` (= `cached` rows) | **313** (28.8 % of requests) | 0 |
| `candidatesRanked` / `candidatesTested` | **8,806 / 29,297** | — |
| stop: complete / max_replans / replan_stop / max_steps / wall cap | 12 / 1 / 5 / 0 / **0** | 0 / 0 / 0 / **10** / 0 |

Censoring is the same shape as the previous slice and runs the same way: the tuned arm is bounded by steps (10 of 18 at `max_steps`), `llm-jev` by replans (6 of 18), neither by the wall. The both-solved row is the only uncensored comparison and it covers 8 QuixBugs tasks.

### 4.2 Per suite

| suite | arm | pass | correct | overfit | steps-to-solve median | wall median (all) | $ total | $/solved | Jev req | ranked / tested |
|---|---|---|---|---|---|---|---|---|---|---|
| QuixBugs 8 (fresh) | `llm-jev` | **8/8** [68 %, 100 %] | 8 (6 gold-identical + 2 equivalent) | **0** | 3 | 26.0 s | $0.004924 | $0.0006 | 33 | **0** / 2,878 |
| QuixBugs 8 | `jev-off-tuned` | **8/8** | 8 (4 + 4) | 0 | 7.5 | **19.7 s** | $0.024147 | $0.0030 | 0 | — |
| ladder **long-2** 6 | `llm-jev` | **4/6** [30 %, 90 %] | 3 (0 gold-identical + 3 equivalent) | **1 strong** (`token_bucket`) | 12.5 | 414.2 s | $0.199485 | $0.0499 | 927 | 1,846 / 26,399 |
| ladder long-2 6 | `jev-off-tuned` | **0/6** [0 %, 39 %] | 0 | 0 | n/a | **136.6 s** | $0.111154 | n/a | 0 | — |
| SWE 4 (fresh, django) | `llm-jev` | **0/4** [0 %, 49 %] | 0 | 0 | n/a | **62.2 s** | $0.047259 | n/a | 126 | **6,960 / 20** |
| SWE 4 | `jev-off-tuned` | **1/4** (1 record `pass: null`) | 1 | 0 | 12 | 167.4 s | $0.108173 | $0.1082 | 0 | — |

Per-suite discordance: QuixBugs b = 0 / c = 0 (8 both); ladder **b = 4 / c = 0** (p = 0.063), neither 2 (`csv_schema` `max_replans`, `route_match` `replan_stop`); SWE b = 0 / c = 1.

**Long-2 is the result.** The tier exists to test whether an agent can hold two hunks in two files as one edit; four of the six fall to `llm-jev` and none to a tuned generator that runs 30 steps at each of them. Its two misses are the two tasks whose coupled pair spans the most modules. The one blemish is `token_bucket`, committed as a **strong overfit** (8 of 644 probed calls differ; the tier's own "mildest pair") — the guard arbitrated it through.

**SWE is a different failure from last time, not a better one.** All four runs end `replan_stop` at exactly **5 steps and 60–100 s**, having tested **five candidates in total** while pricing **6,960**. The previous slice burnt 25 minutes and $0.2178 on one instance; this one gives up in a minute. Change 7's escalation-or-stop rule is what ends them, and on a repository it ends them before the search has run anything.

## 5. Question (b): the in-sample 28

**27/28.** The lost task is **`django__django-15128`** — `replan_stop` at 7 steps / 129.4 s / $0.0107, against `generator_done`-style completion at `066816f`. It is the only regression; the other five SWE instances self-terminate `complete` at 2 steps and pass, QuixBugs is 10/10 and ladder short 12/12.

| metric | `llm-jev` @ `751e3bf` (this run) | `llm-jev` @ `066816f` (frozen ref) | same-build plain / tuned (ref) |
|---|---|---|---|
| pass | **27/28** | 28/28 | 21/28 / 22/28 |
| correct-by-verdict | **26/28** (QuixBugs 9/10, ladder 11/12, SWE = pass 5/6) | 26/28 | 20/28 / 20/28 |
| overfits | `detect_cycle` (QuixBugs), `stats` (ladder, weak) | the same two | — |
| median wall | 75.6 s | 63.0 s (1.20× against) | 246.3 s / 111.4 s |
| $ total | **$0.078279** | $0.144138 (**0.54×**) | $0.587483 / $0.242607 |
| Jev requests / questions | **394 / 6,199** | 482 / — | 0 |
| `jevCacheHits` | 68 (17.3 %) | n/a (not recorded) | 0 |
| `candidatesRanked` / `candidatesTested` | **867 / 32,397** | — | — |
| stop: complete / replan_stop | 27 / 1 | 28 / 0 | — |

## 6. Predicted versus observed, per change

| # | change | predicted | observed | held? |
|---|---|---|---|---|
| 1 | SIEVE/RANK gated on "the pool has a passer" | −81 % ranking requests, `ranked ≈ tested`, −68 % Jev $ | in-sample **867 ranked / 32,397 tested** (2.7 %); fresh QuixBugs **0 ranked** / 2,878 tested; ladder 1,846 / 26,399 (7 %); **SWE 6,960 ranked / 20 tested**. In-sample Jev requests 394 vs 482 (−18 %), Jev $ $0.0373 vs $0.0986 (−62 %) | **yes on QuixBugs and ladder, no on repositories** |
| 2 | per-run `requestHash` cache, hits marked | −19.5 % requests, hits countable | `jevCacheHits` **313** fresh / **68** in-sample, exactly equal to the `cached` rows (review finding 8's fix works); QuixBugs 0 hits, as predicted | **yes** |
| 3 | generator deadline back-off on zero-token timeouts | recovers 1,170 s + 1,532 s of dead sample time | fresh slice **135 of 290 samples (46.6 %)** are zero-token timeouts, **3,501 s of 5,506 sample-seconds (63.6 %)**; in-sample 37 of 110 (33.6 %), 895 s of 1,944 s | **no — worse** |
| 4 | goal clustering by shared file / call chain; site-budget split | targets the `plausible = 0` losses; QuixBugs must stay 1 goal | QuixBugs **1 goal on all 18 runs**; 27 multi-test goals (2–13 tests) on ladder/SWE, 129 single-test; **no site-budget split ever fired** (`<parent>.N` ids absent); the two long-2 misses still reach `plausible 0` on 12–15 steps | **yes (no re-fit), but it did not rescue the misses** |
| 5 | reject implicit-`None` exits / new argument mutation | catches `detect_cycle` and `stats` | over 58 runs: **2** hard refusals of a passing candidate, **1** `adds_implicit_none_exit`, **5** `mutates_new_argument` recorded as a *suspicion only* (review fix 2). `detect_cycle` is an overfit again (a different patch: "token 21 `.` vs `is`"), `stats` a weak overfit again | **no** |
| 6 | drop the degenerate families, stop asking `task_complete` every step | −180 requests, −$0.027 | `complete|task_complete` asked **15×** (fresh) / **32×** (in-sample) against 127; `replan|task_impossible`, `risk|destructive`, `risk|irreversible` absent from the family tables; `completion` is `null` when unasked | **yes** |
| 7 | break the `gather_context` replan loop | reclaims crossfile's 893 s and six_hunks' 742 s | fresh `next_move` = `gather_context` 14 / `change_approach` 2 / `stop_and_report` 4 (70 %, was 84.6 %); one forced escalation; steps with no patch proposed 4/5 on each SWE run. 6 of 18 fresh runs end on the replan budget, and it is what costs `django__django-15128` in-sample | **yes mechanically; it buys the stop, not the fix** |
| 8 | no `complete` on an issue-oracle repro alone | keeps sympy-20428 searching | no fresh SWE run self-terminates `complete`; the five in-sample oracle-valid instances still do, at 2 steps, and all five pass eval | **no counter-example; not testable on this slice** |

## 7. Ring 1 and Ring 2 (`experiments/harness-next/quick.mts`, same tree, `JEVCODE_WARM=off`)

**Ring 1 — `--jev off` safety gate ($0): FAIL.**

```
  --jev off keeps what Jev solves, quixbugs  Jev on 2/3 pass → off 0/3; lost gcd, mergesort  every task Jev-on solves, Jev-off solves FAIL
    only slower, quixbugs                    no task solved by both arms                     report (a router fallback costs wall, never correctness) ·
    faster AND unsolved, quixbugs            gcd, mergesort                                  the false-green signature: replanned into the cap FAIL
  --jev off keeps what Jev solves, ladder    Jev on 2/2 pass → off 1/2; lost units           every task Jev-on solves, Jev-off solves FAIL
    only slower, ladder                      0.84× the Jev-on wall over 1 task(s)            report (a router fallback costs wall, never correctness) ·
    faster AND unsolved, ladder              units                                           the false-green signature: replanned into the cap FAIL
  replay of the 28 head-to-head run dirs     not landed                                      src/loop/replay.ts + `inspect --replay` (needs src/cli/**) ·

quick: a gate failed (git 751e3bf)
```

**Ring 2 — the five tiny live tasks ($0.0032 of a $0.05 cap): 5/5 pass, REJECT.**

```
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
```

Both rings were also attempted at the default: Ring 1 reached one step in twelve minutes before it was killed, for the reason in §3.

## 8. What this does and does not settle

Settled: the eight ranked changes are measurable and, on a slice nobody tuned against, they buy the whole of the ladder long-2 tier over tuned generator-only at parity of cost; the in-sample cost of the mode falls by 46 % and its Jev traffic by 18 %; the cache is now countable; QuixBugs did not become a multi-goal problem. Also settled, and more urgent: **the shipped default cannot run the synthesizer at all**, and the fault is the warm plane, not this iteration's work.

Not settled, and not claimed: n is 18 and 28; there is no repeat run of anything here; `sign p = 0.1875` on the fresh slice is not significance, it is a direction; change 1's repository behaviour is *worse*, not better, and 6,960-against-20 is the number the next iteration has to attack; change 3 did not fire as designed and the generator still loses two thirds of its sample-seconds to zero-token timeouts; change 5 has not caught either of the two correctness losses it was written for; change 7 buys its stop with `django__django-15128`. One tuned SWE record (`django__django-14787`) is `pass: null` / `evaluator: invalid` ("no test results and no sign the suite ran"), so the SWE pairing there is n = 3. Ladder correctness is still judged by `perturb.ts`'s own `LADDER_HARNESS`; SWE correctness is still pass. `llm-sieve` was not run (`ConfigError`), so criterion 5's attribution question is still open.
