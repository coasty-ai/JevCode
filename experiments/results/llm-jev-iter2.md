# OOS iteration 2, measured: the same fresh 18 and in-sample 28, a real-model warm A/B, and a shared machine that decided what could be measured — 2026-09-22 (runs 15:24–19:40 Z)

Everything below ran from the frozen worktree `.claude/worktrees/iter2-clean` at HEAD **`d86c385`** (`git status`: only
the `node_modules` symlink untracked; the build was already in place), jevcode **0.5.0**, generator
`openrouter z-ai/glm-5.3-flash`, Jev `jev-1.13.0`. Every live command was
`env -u ANTHROPIC_API_KEY JEVCODE_WARM=<off|on> node --env-file=<main>/.env bin/jevcode.js bench --live …`; no key
appears here or in the logs under `/tmp/iter2/` (every tail filtered through `grep -vE 'sk-|api[_-]?key'`, nothing
matched). Results and their archived run records are written into this worktree and committed on `bench-iter2`.
**Total spend $1.0413** of a $4 cap. Script output: `llm-jev-iter2.tool.md`.

## 0. Verdict

**(0) Read every wall number in this document next to its loadavg.** The machine (15 cores) was shared for the whole
window with a peer session and other agents — among them a second continuously-running `jevcode bench` out of
`.claude/worktrees/agent-a0e454553ff6a690f` and a `tsc` at 142 % CPU. Recorded `loadavg[0]` per task record ranges
**2.9 to 175**. Iteration 1's arms ran at 2.4–45. Pass counts, costs, step counts, Jev traffic and every counter are
unaffected; **wall is not**, and neither are the two tasks that died on a budget rather than on a search
(`account`, in-sample ladder, and to a degree the fresh `hunk_merge`). One comparison in this document is
load-matched and is the only one quoted as a timing result: **§6, the back-to-back QuixBugs triple** — warm-off,
warm-on and `jev-off-tuned` over the same 8 tasks, run consecutively inside one seven-minute low-load window.
A second finding falls straight out of the load records and is a **correction to iteration 1**: `llm-jev` generates
its own load (eight SIEVE lanes × `--concurrency 4`), so iteration 1's QuixBugs arm ran at loadavg 4.2→23.2 while
its `jev-off-tuned` control ran at 3.1–3.4 throughout. Iteration 1's headline "`llm-jev` is slower than tuned on
QuixBugs, 26.0 s vs 19.7 s (1.32×)" was measured against a baseline that never saw the candidate's load. At matched
load the ratio is **1.16×**, not 1.32× — the direction survives, the size does not.

**(a) The fresh 18 improve, and for the first time the improvement is on repositories.** `llm-jev` at `d86c385` is
**14/18** (Wilson [54.8 %, 91.0 %]) against iteration 1's 12/18 and the tuned generator's **9/18** ([29.0 %, 71.0 %]);
discordance **b = 5 / c = 0**, one-sided exact sign test **p = 0.0312** — iteration 1's p was 0.1875 with b = 4 / c = 1.
**SWE moves off zero: 2/4** (`django__django-15375`, `django__django-16100`) where iteration 1 was 0/4, and the
five-step `replan_stop` that ended every repository run is gone — the three that still stop by replan do so at
**14, 17 and 14 steps** having actually searched. QuixBugs stays 8/8 with zero overfits; ladder long-2 stays 4/6 but
**solves a different four** (`csv_schema` in, `hunk_merge` out) at a third of iteration 1's steps on the ones it
shares. Cost is flat ($0.2489 vs $0.2435 for the tuned arm; $0.2517 in iteration 1). **QuixBugs did not stop being
slower than tuned** — at matched load the median per-task ratio is 1.163 and `llm-jev` is slower on 6 of 8 — but it
is a fifth to a quarter of the cost, and the gap has closed from 1.406 to 1.163.

**(b) The in-sample 28 are 27/28 again, but the task that regressed is a different one, and it is a casualty of the
machine, not of the build.** `django__django-15128` — iteration 1's single regression, the case change 9 was written
for — **passes**, `complete` at 6 steps. The one loss is ladder `account`, at `max_replans` after 20 steps under
**loadavg 99–175**; the *same task at the same build* passes in the warm arm (C5) forty minutes later at loadavg 13.
Correctness moved where it was aimed: **`detect_cycle` is gold-identical**, the overfit iteration 1 called out for
change 5. `stats` is still a weak overfit, and `wrap` picked up a fresh one (gold-identical in the other arm of the
same day, so run-to-run, not structural).

**(c) Three of the four iteration-2 changes hold cleanly; the fourth holds half.** `doneClaimEscalation` fires 8× on
the fresh slice and 3× in-sample and is what buys SWE and `django__django-15128`. `rankPoolCap` on the repository
RANK site turns iteration 1's **6,960 priced / 20 tested** into **751 priced / 1,060 tested** — the pricing path no
longer outruns the step by two orders of magnitude. The deadline high-water mark holds absolutely: **no goal's
deadline shrank after a zero-token timeout in any of the six arms**, and zero-token timeouts fall from 46.6 % of
samples to **27.2 %** on the fresh slice and from 33.6 % to **6.9 %** in-sample (sample-seconds 63.6 % → 40.9 % and
46.0 % → 19.8 %). The localiser fallback is the half: Ring 1's **QuixBugs `--jev off` gate now passes** (`gcd` and
`mergesort` recovered) but the **ladder gate still fails on `units`**, so Ring 1 is still red.

**(d) The warm plane is fixed as a transport and is genuinely faster — and it must stay OFF, because it loses
tasks.** Over 93,460 offered screens in seven warm-on arms: **0 fallbacks, 0 restarts, 0 screen:mismatch,
0 `disabledReason`, 0 wedges.** Iteration 1's wedge is gone; Ring 1 runs to completion with the plane on where
iteration 1 had to kill it after twelve minutes at one step. At matched load warm is **23 % faster** (median
per-task ratio **0.767**, faster on **7/7** of the tasks both arms solve; 207.8 s → 154.6 s over those seven).
But warm-on **loses QuixBugs tasks that warm-off solves**: `topological_ordering` twice independently (at loadavg 150
and at loadavg 35) and `shortest_path_length` once — three losses against zero the other way. The cause is not the
transport: a warm screen is bounded by the **lane run cap**, not by the sieve's adapted **per-case** timeout, so one
diverging candidate costs ~12–14 s hot against ~0.5–1.2 s cold, that duration feeds the sieve's run-median
estimator, the step's test wall drains, and every later batch reports `0 tested … (nothing ran)`.
**Recommendation: keep the default OFF** (criterion in §7.4, written before the matched pair ran).

## 1. What was run

| arm | out dir | condition | suite | pass | bench id | spend | loadavg[0] range |
|---|---|---|---|---|---|---|---|
| C1.1 | `iter2-fresh-llm-jev-quixbugs` | llm-jev, warm off | quixbugs | 8/8 | `20260922-152438-877d6c` | $0.005481 | 4.6–22.5 |
| C1.2 | `iter2-fresh-llm-jev-ladder-long2` | llm-jev, warm off | ladder | 4/6 | `20260922-152601-754532` | $0.153358 | 21.3–29.3 |
| C1.3 | `iter2-fresh-llm-jev-swebench` | llm-jev, warm off | swebench | 2/4 | `20260922-155127-abb734` | $0.090088 | 59.8–77.0 |
| C2.1 | `iter2-fresh-llm-jev-warm-quixbugs` | llm-jev, warm on | quixbugs | 7/8 | `20260922-161809-0b2694` | $0.017415 | 150.0–155.0 |
| C2.2 | `iter2-fresh-llm-jev-warm-ladder-long2` | llm-jev, warm on | ladder | 4/6 | `20260922-162231-c7be1f` | $0.137437 | 43.6–79.1 |
| C2.3 | `iter2-fresh-llm-jev-warm-swebench` | llm-jev, warm on | swebench | 2/4 | `20260922-164743-1e32c0` | $0.070502 | 38.3–55.9 |
| C3 | `iter2-fresh-jev-off-tuned-quixbugs` | jev-off-tuned, warm off | quixbugs | 8/8 | `20260922-170654-368961` | $0.019247 | 52.0–54.9 |
| C4.1 | `iter2-insample-llm-jev-quixbugs` | llm-jev, warm off | quixbugs | 10/10 | `20260922-170809-1bbb17` | $0.038524 | 56.7–88.6 |
| C4.2 | `iter2-insample-llm-jev-ladder` | llm-jev, warm off | ladder | 11/12 | `20260922-171604-56f0ab` | $0.063228 | 98.8–175.4 |
| C4.3 | `iter2-insample-llm-jev-swebench` | llm-jev, warm off | swebench | 6/6 | `20260922-173145-925eca` | $0.062425 | 10.4–44.9 |
| C5.1 | `iter2-insample-llm-jev-warm-quixbugs` | llm-jev, warm on | quixbugs | 9/10 | `20260922-175505-c68f89` | $0.032178 | 2.9–25.8 |
| C5.2 | `iter2-insample-llm-jev-warm-ladder` | llm-jev, warm on | ladder | 12/12 | `20260922-180021-ba7a5f` | $0.026287 | 12.7–29.4 |
| C6a | `iter2-bb-llm-jev-warmoff-quixbugs` | llm-jev, warm off | quixbugs | 8/8 | `20260922-174641-38619f` | $0.005230 | 4.6–27.6 |
| C6b | `iter2-bb-llm-jev-warmon-quixbugs` | llm-jev, warm on | quixbugs | 7/8 | `20260922-174804-cf3482` | $0.019077 | 34.9–37.1 |
| C6c | `iter2-bb-jev-off-tuned-quixbugs` | jev-off-tuned, warm off | quixbugs | 8/8 | `20260922-175158-00a27d` | $0.018886 | 4.1–5.3 |
| C7a | `iter2-bb-llm-jev-warmoff-ladder-long2` | llm-jev, warm off | ladder | 5/6 | `20260922-184533-3a5340` | $0.114396 | 38.2–114.2 |
| C7b | `iter2-bb-llm-jev-warmon-ladder-long2` | llm-jev, warm on | ladder | 5/6 | `20260922-191224-2e3e26` | $0.162694 | 46.3–120.5 |

Arms ran strictly one after another, suites sequentially inside an arm, each detached under `nohup` with a log in
`/tmp/iter2/` ending `ALLDONE exit 0`. The sentinel `/tmp/jevcode-perf-window-open` was checked before every arm and
never existed. Every results directory carries its own `runs/<runId>/*.gz` (`--archive-runs`) and its `verdicts.md`,
**and a `transcripts/<runId>.log`** — `--archive-runs` does not copy the live run's `transcript.log`, and the warm
counters exist nowhere else (see §10, defect 1), so each was harvested from `~/.jevcode/runs/<runId>/` immediately
after its arm.

### 1.1 Exact commands

Identical to `llm-jev-iter1.md` §1.1 — same task ids, concurrency, steps, wall and caps — with `<OUT>` and
`JEVCODE_WARM` substituted per arm:

```
cd /Users/prateekjannu/Documents/vscode/JevCode/.claude/worktrees/iter2-clean   # detached at d86c385, built, node_modules symlinked

# C1 (warm off) and C2 (warm on): the fresh 18
env -u ANTHROPIC_API_KEY JEVCODE_WARM=<off|on> node --env-file=<main>/.env bin/jevcode.js bench \
  --suite quixbugs --conditions llm-jev --live \
  --task-id quicksort,rpn_eval,shortest_path_lengths,shortest_paths,sieve,subsequences,to_base,topological_ordering \
  --concurrency 4 --max-steps 12 --max-wall 8m --spend-cap 0.5 --task-spend-cap 0.06 \
  --archive-runs --out <wt>/bench/results/iter2-fresh-llm-jev[-warm]-quixbugs
env -u ANTHROPIC_API_KEY JEVCODE_WARM=<off|on> node --env-file=<main>/.env bin/jevcode.js bench \
  --suite ladder --conditions llm-jev --live \
  --task-id csv_schema,deadline_queue,dep_order,hunk_merge,route_match,token_bucket \
  --concurrency 2 --max-steps 30 --max-wall 15m --spend-cap 1.2 --task-spend-cap 0.18 \
  --archive-runs --out <wt>/bench/results/iter2-fresh-llm-jev[-warm]-ladder-long2
env -u ANTHROPIC_API_KEY JEVCODE_WARM=<off|on> NODE_OPTIONS=--max-old-space-size=8192 node --env-file=<main>/.env bin/jevcode.js bench \
  --suite swebench --conditions llm-jev --live \
  --task-id django__django-14787,django__django-16100,django__django-14725,django__django-15375 \
  --concurrency 2 --max-steps 25 --max-wall 25m --spend-cap 1.0 --task-spend-cap 0.25 \
  --archive-runs --out <wt>/bench/results/iter2-fresh-llm-jev[-warm]-swebench

# C3: the same-session tuned timing control, the same 8 QuixBugs, the same limits
… --suite quixbugs --conditions jev-off-tuned --live --task-id <the same 8> --concurrency 4 --max-steps 12 \
  --max-wall 8m --spend-cap 0.5 --task-spend-cap 0.06 --archive-runs --out …/iter2-fresh-jev-off-tuned-quixbugs

# C4 (warm off) and C5 (warm on, cheap tiers only): the in-sample 28 / 22, iteration 1 arm B's limits
… --suite quixbugs --conditions llm-jev --live --task-id bitcount,bucketsort,detect_cycle,find_in_sorted,gcd,kth,lis,mergesort,shortest_path_length,wrap \
  --concurrency 4 --max-steps 12 --max-wall 8m --spend-cap 0.8 --task-spend-cap 0.06 --archive-runs --out …/iter2-insample-llm-jev[-warm]-quixbugs
… --suite ladder   --conditions llm-jev --live --tasks 12 --concurrency 3 --max-steps 25 --max-wall 12m --spend-cap 1.2 --task-spend-cap 0.1 --archive-runs --out …/iter2-insample-llm-jev[-warm]-ladder
… --suite swebench --conditions llm-jev --live --task-id sympy__sympy-15345,sympy__sympy-17139,sympy__sympy-19954,sympy__sympy-11618,django__django-15128,django__django-15315 \
  --concurrency 2 --max-steps 25 --max-wall 25m --spend-cap 1.5 --task-spend-cap 0.25 --archive-runs --out …/iter2-insample-llm-jev-swebench

# C6 (added by this measurement, §6): the three arms of the fresh QuixBugs 8 run back-to-back in one window,
#   warm off -> warm on -> jev-off-tuned, all other flags exactly as C1.1/C3
… --archive-runs --out …/iter2-bb-{llm-jev-warmoff,llm-jev-warmon,jev-off-tuned}-quixbugs

# the harvest --archive-runs does not do
for r in $(ls <out>/runs); do cp ~/.jevcode/runs/$r/transcript.log <out>/transcripts/$r.log; done

# verdicts (one results dir per call), head-to-head, rings
node_modules/.bin/tsx experiments/inspect/quixbugs-verdicts.mts bench/results/<dir>
node_modules/.bin/tsx experiments/inspect/ladder-verdicts.mts   bench/results/<dir>
node_modules/.bin/tsx experiments/llm-jev/headtohead.mts \
  bench/results/iter1-fresh-jev-off-tuned-{quixbugs,ladder-long2,swebench} bench/results/iter2-fresh-jev-off-tuned-quixbugs \
  bench/results/iter2-fresh-llm-jev-{quixbugs,ladder-long2,swebench} --candidate llm-jev --baseline jev-off-tuned
env -u ANTHROPIC_API_KEY JEVCODE_WARM=<off|on> node --env-file=<main>/.env node_modules/.bin/tsx experiments/harness-next/quick.mts --ring 1
env -u ANTHROPIC_API_KEY JEVCODE_WARM=off      node --env-file=<main>/.env node_modules/.bin/tsx experiments/harness-next/quick.mts --ring 2 --live --spend-cap 0.05
```

## 2. The task lists

Unchanged from iteration 1 and reproduced by the same rules (`llm-jev-iter1.md` §2), so the two measurements are
paired task for task: the 8 remaining eligible fresh QuixBugs, the whole ladder **long-2** tier, and the four
non-sympy / non-oracle-valid / never-passed SWE instances (a django monoculture, not a Verified estimate). The
in-sample 28 are the original 10 QuixBugs, ladder `--tasks 12` and the 6 SWE instances of the v2 report.

## 3. The machine, and what it cost the measurement

`hw.ncpu` = 15. Recorded `loadavg[0]` at the moment each record was written:

| arm | loadavg[0] min–max | note |
|---|---|---|
| C1 QuixBugs / ladder / SWE | 4.6–22.5 / 21.3–29.3 / 59.8–77.0 | comparable to iteration 1's own arm (4.2–23.2) |
| C2 QuixBugs / ladder / SWE | **150.0–155.0** / 43.6–79.1 / 38.3–55.9 | a peer bench + a 142 %-CPU `tsc` were resident |
| C3 (tuned control) | 52.0–54.9 | generator-bound; see below |
| C4 QuixBugs / ladder / SWE | 56.7–88.6 / **98.8–175.4** / 10.4–44.9 | `account` died here |
| C5 QuixBugs / ladder | 2.9–25.8 / 12.7–29.4 | the machine had quietened |
| C6 (all three arms) | 4.1–37.1 | the one load-matched window |

Two consequences, both of which change how iteration 1 should be read.

**The candidate makes its own load; the baseline does not.** `llm-jev` dispatches eight SIEVE lanes per run and the
QuixBugs arms run `--concurrency 4`, so 32 Python processes are normal; `jev-off-tuned` spawns none and is bounded
by generator latency. C3 is the proof: at loadavg 52–55 the tuned arm's median wall is **13.0 s**, *faster* than
iteration 1's tuned arm at loadavg 3.1–3.4 (19.7 s). A wall comparison between the two conditions is therefore a
comparison between a CPU-bound and a network-bound program, and iteration 1 ran the CPU-bound one at 5–7× the
baseline's load without saying so. §6 fixes this by running all three arms in one window.

**Two task losses are budget losses, not search losses.** In-sample ladder `account` ends `max_replans` at 20 steps
under loadavg 99–175 (C4.2) and passes at loadavg 13 forty minutes later (C5.2). The fresh `hunk_merge` ends
`max_replans` at 20 steps / 878 s in C1.2 and passes at 8 steps / 539 s in C2.2. Neither is called a regression here.


## 4. Question (a): the fresh 18

### 4.1 Pooled (18 paired tasks, nothing tuned against them)

| metric | `llm-jev` @ `d86c385` | `llm-jev` @ `751e3bf` (iter 1) | `jev-off-tuned` |
|---|---|---|---|
| pass | **14/18** (Wilson [54.8 %, 91.0 %]) | 12/18 ([43.7 %, 83.7 %]) | **9/18** ([29.0 %, 71.0 %]) |
| correct-by-verdict (SWE = pass) | **13/18** | 11/18 | 9/18 |
| discordance vs tuned, pass | **b = 5 / c = 0**, both 9, neither 4; sign p = **0.0312** | b = 4 / c = 1; p = 0.1875 | — |
| the five wins | `deadline_queue`, `dep_order`, `csv_schema`, `token_bucket`, `django__django-15375` | — | — |
| $ total | $0.248927 | $0.251668 | $0.243474 |
| … generator / Jev | $0.145529 / $0.103398 | $0.101685 / $0.149982 | $0.243474 / $0 |
| Jev requests / questions | **877 / 11,156** | 1,086 / 13,541 | 0 / 0 |
| `jevCacheHits` (= `cached` rows) | **290** (33.1 % of requests) | 313 (28.8 %) | 0 |
| `candidatesRanked` / `candidatesTested` | **2,302 / 27,559** | 8,806 / 29,297 | — |
| stop: complete / max_replans / replan_stop / max_steps | **12 / 3 / 3 / 0** | 12 / 1 / 5 / 0 | 0 / 0 / 0 / 10 |
| median wall (all 18) | 138.2 s at loadavg 4.6–77 | 60.9 s at loadavg 2.4–23 | 71.1 s at loadavg 2.4–3.4 |

The wall row is **not** a result: the three arms saw loadavg medians of 21.9, 16.0 and 3.2. §6 is the wall result.

### 4.2 Per suite

| suite | arm | pass | correct | overfit | steps-to-solve median | $ total | $/solved | Jev req | ranked / tested |
|---|---|---|---|---|---|---|---|---|---|
| QuixBugs 8 (fresh) | `llm-jev` | **8/8** [68 %, 100 %] | 8 (5 gold-identical + 3 equivalent) | **0** | 3 | $0.005481 | $0.0007 | 35 | **0** / 2,431 |
| QuixBugs 8 | `jev-off-tuned` (C3) | **8/8** | 8 (4 + 4) | 0 | 5 | $0.019247 | $0.0024 | 0 | — |
| ladder **long-2** 6 | `llm-jev` | **4/6** [30 %, 90 %] | 3 (0 + 3) | **1 strong** (`token_bucket`) | 4 | $0.153358 | $0.0383 | 664 | 1,551 / 24,068 |
| ladder long-2 6 | `jev-off-tuned` (iter 1) | **0/6** [0 %, 39 %] | 0 | 0 | n/a | $0.111154 | n/a | 0 | — |
| SWE 4 (fresh, django) | `llm-jev` | **2/4** [15 %, 85 %] | 2 | 0 | 14 | $0.090088 | $0.0450 | 178 | **751 / 1,060** |
| SWE 4 | `jev-off-tuned` (iter 1) | 1/4 (one record `pass: null`) | 1 | 0 | 12 | $0.108173 | $0.1082 | 0 | — |

Per-suite discordance against the tuned arm: QuixBugs b = 0 / c = 0 (8 both); ladder **b = 4 / c = 0** (p = 0.063),
neither 2 (`hunk_merge` `max_replans`, `route_match` `max_replans`); SWE **b = 1 / c = 0**, both 1, neither 1 (n = 3;
`django__django-14787` is `pass: null` on the tuned side, as in iteration 1).

**SWE is the move.** Iteration 1 ended all four repository runs at `replan_stop` after exactly **5 steps and
60–100 s**, having tested 5 candidates while pricing 6,960. Iteration 2 ends them at **14, 17, 14 and 21 steps**
(282 s, 643 s, 622 s, 212 s), having tested **1,060** against **751** priced, and two of them pass. The two changes
responsible are visible in the transcripts: `doneClaimEscalation` fires **8 times** on this slice (a refused
`done:` claim climbing `SEEDS → SKETCH/WIDENED` instead of ending the run) and `rankPoolCap` holds the RANK site to
what the step can run.

**Ladder long-2 is a wash on count and a win on effort.** Same 4/6, different four: `csv_schema` (iteration 1's
`max_replans` at 24 steps / 869 s) is solved at **8 steps / 432 s**, and `hunk_merge` (iteration 1's 13 steps) is
the new miss at `max_replans` 20 under loadavg 29 — it passes in C2.2 at 8 steps. The three tasks both iterations
solve cost far less work: `deadline_queue` 9 steps → **3**, `dep_order` 12 → **3**, `token_bucket` 3 → 5.
A third run of the same tier at the same build (C7a, §7.2b) solves **5/6** — `csv_schema` *and* `hunk_merge` —
so 4/6 is the tier's low sample, not its level; see §7.2b for all three.

`token_bucket` is still committed as a **strong overfit**, in **all four** ladder long-2 arms run today (four of
four, always at the same divergence, `bucket.py` token 172 `self` vs `if`). The thresholdless rule iteration 2 scoped for it is not
among the four changes this build landed (`git diff --stat 9292d44..d86c385 -- src/synth/` touches only `llm/source.ts`, `localize/index.ts`, `search/subgoal.ts` and `warm/**` — no guard or arbitration file), so this is
an open item carried forward, not a failed prediction.


## 5. Question (b): the in-sample 28

**27/28, and the one that goes is a different task from iteration 1's.** `django__django-15128` — the regression
iteration 1 attributed to change 7's forced stop and iteration 2 re-diagnosed as the refused-`done:` deadlock —
now ends **`complete` at 6 steps / 328 s** and passes. The loss is ladder **`account`**, `max_replans` at 20 steps
/ 714 s, recorded at **loadavg 99–175**; the same task at the same build passes in C5.2 (`complete`) at loadavg 13.
Paired against iteration 1: **b = 1 (`django__django-15128`) / c = 1 (`account`)**, sign p = 0.75.

| metric | `llm-jev` @ `d86c385` (C4) | `llm-jev` @ `751e3bf` (iter 1) | `llm-jev` @ `066816f` (frozen ref) |
|---|---|---|---|
| pass | **27/28** ([82.3 %, 99.4 %]) | 27/28 | 28/28 |
| correct-by-verdict | **25/28** (QuixBugs 9/10, ladder 10/12, SWE = pass 6/6) | 25/28 (9/10 + 11/12 + 5/6) | 26/28 |
| overfits | `wrap` (QuixBugs), `stats` (ladder, weak) — **`detect_cycle` is now gold-identical** | `detect_cycle`, `stats` | the same two |
| $ total | $0.164177 | $0.078279 | $0.144138 |
| Jev requests / questions | **841 / 7,530** | 394 / 6,199 | 482 / — |
| `jevCacheHits` | 205 (24.4 %) | 68 (17.3 %) | n/a |
| `candidatesRanked` / `candidatesTested` | **2,560 / 22,006** | 867 / 32,397 | — |
| zero-token timeouts | **15 of 218 samples (6.9 %)**, 520 s of 2,626 (19.8 %) | 37 of 110 (33.6 %), 895 s of 1,944 (46.0 %) | — |
| stop: complete / max_replans / replan_stop | **26 / 1 / 1** | 27 / 0 / 1 | 28 / 0 / 0 |
| median wall | 138.9 s at loadavg 10–175 | 75.6 s at loadavg 2.9–45 | 63.0 s |

Cost and Jev traffic went **up** against iteration 1 (2.1× and 2.1×), which is the honest reading of a slice where
the median loadavg was 88 against 16: `bitcount` took 12 steps instead of 3 and `lis` 8 instead of 3 because the
search kept running out of test wall and replanning. The warm arm over the same cheap tiers (C5, loadavg 3–29) is
the control: QuixBugs 10 at **$0.032** and ladder 12 at **$0.026**, against C4's $0.039 and $0.063.

`detect_cycle` is the one correctness claim this iteration can make in-sample: iteration 1 committed a patch that
differed from gold at token 21 (`.` vs `is`) and failed 1/500 random cases; iteration 2 commits the gold file.
`wrap` replaces it in the overfit column (3/24 perturbed inputs differ), and is **gold-identical in C5.1 on the
same build the same evening** — so that column is 1 either way and neither task is a stable property of the build.

*(Arithmetic note: iteration 1's report records its own in-sample correct-by-verdict as 26/28 while listing
9/10 + 11/12 + 5/6, which is 25. Both iterations are 25/28 by their own component counts; the table above uses
the components.)*


## 6. The load-matched window: `llm-jev` warm-off, `llm-jev` warm-on and `jev-off-tuned` back to back

Three arms over the same 8 fresh QuixBugs tasks, same flags, run consecutively between **17:46:41 Z and
17:53:18 Z** — the only stretch of the day when the machine was near idle. This is the measurement the wall-clock
questions are answered from; everything in §4, §5 and §7.1 is pass/cost/counter data.

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

**`llm-jev` against the tuned generator on the one-line regime.** `llm-jev` is still slower — median per-task
ratio **1.163**, slower on **6 of 8** — but the median walls are 28.2 s against 26.0 s (1.08× on medians), not
iteration 1's 26.0 s against 19.7 s. Iteration 1's 1.406 per-task median was taken across a 5–7× load gap; the
honest number for this build at equal load is **1.16×**, at **0.28× the cost** ($0.0052 against $0.0189). The
answer to "did QuixBugs stop being slower than tuned" is **no, but the gap roughly halved and it is now within the
run-to-run spread** (the same comparison at unmatched load in §4 reads 2.21×).

**Warm against cold.** Warm is faster on **7 of 7** tasks both arms solve, median ratio **0.767**, and the seven
together take 154.6 s against 207.8 s (−25.6 %) — while the warm arm's recorded loadavg was *higher* (35.0 against
12.2 median), so the effect is if anything understated. The S0 bucket shares barely move (`synth` 97.7 % → 97.0 %,
generator 21.8 % → 21.0 %, the `synth − (gen + jev + exec)` residual that is the lane-verify wall 72.5 % → 71.7 %),
so warm shortens the verify wall proportionally rather than shifting work between buckets.

**And warm loses a task in the same window.** `topological_ordering` passes cold in 42.6 s and fails hot at
`max_steps` after 210.1 s — the second independent reproduction of the same loss (C2.1 lost it too, at loadavg
150). §7.2 is why.


## 7. Question (d): the warm verification plane A/B

### 7.1 Health — the transport fault is gone

Over seven warm-on arms (C2.1–C2.3, C5.1–C5.2, C6b, C7b), scraped from the harvested transcripts:

| counter | total |
|---|---|
| screens offered / screened | **93,460 / 93,460** (100 %) |
| `fallbacks` | **0** |
| `restarts` | **0** |
| `screen:mismatch` | **0** |
| `disabledReason` | **0** (no string ever emitted) |
| `scope_unusable` | 4 |
| cold confirms | 105 |
| **deadline rechecks** | **286** |
| runs wedged at 0 % CPU with no children | **0** |

Iteration 1's signature (`0 tested on 8 lanes (nothing ran); … warm 4/8, 4 fallbacks, 4 restarts; aborted;
LaneError`) does not occur once. Ring 1 with the plane **on** now runs to completion in 12.5 minutes, where
iteration 1 reached one step in twelve minutes and had to be killed. The `07df581` fix works as a transport, and
`WARM_MAX_FAILURES_PER_RUN` / the `serve()` watchdog were never needed on this slice.

One scope note that matters for reading the A/B: **`JEVCODE_WARM=on` is a no-op on SWE-bench.** `warmModeFor`
(`src/synth/warm/plane.ts:122`) returns a mode only for the `quixbugs` and `pytest` runners, and the SWE oracle's
runner is `other` (`… baseline · 367/377 scoped tests pass … (repository, other, python…`). C2.3's transcripts
contain zero warm clauses; its difference from C1.3 is run-to-run variance, not warm.

### 7.2 Speed — and the pass losses

Matched-load result (§6): warm is faster on **7/7** both-solved tasks, median per-task ratio **0.767**, 207.8 s →
154.6 s over the seven. Unmatched arms agree in direction wherever the load favoured warm (in-sample ladder 0.374
median at 6× less load; in-sample QuixBugs 0.337) and disagree where it did not (fresh QuixBugs 1.69 at 13× more
load). Only the matched pair is quoted.

Pass parity, every warm pair run this day:

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

`hunk_merge`, `csv_schema` and `account` are the ladder's ordinary run-to-run spread compounded by load (each
flips in the direction of the *lower*-loaded arm). The QuixBugs column is not: **warm-on loses
`topological_ordering` twice, independently, at loadavg 150 and at loadavg 35, and `shortest_path_length` once**,
and warm-off loses no QuixBugs task in any arm.

### 7.2b The ladder pair (C7), run back-to-back for the same reason — and what it is worth

A second back-to-back pair over the ladder long-2 tier (18:45–19:40 Z), warm-off then warm-on, same flags as C1.2:

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

**Pass parity holds here**: 5/6 both ways, both missing only `route_match`. **The wall is not interpretable.**
The warm arm ran at a 1.56× higher median loadavg (81.9 against 52.6, both far above 8), and — more decisively —
the two arms did *different amounts of work*: `dep_order` took 4 steps cold and 9 hot, `token_bucket` 3 and 6,
`csv_schema` 14 and 7. A per-task wall ratio between trajectories of different length is not a speed measurement,
so the ladder contributes pass parity to the A/B and nothing else. The one-line regime (§6) remains the only
load-matched, same-trajectory wall comparison in this document.

C7's warm-off arm is also the **third independent sample of the ladder long-2 tier at this build, and the best:
5/6** (`csv_schema`, `deadline_queue`, `dep_order`, `hunk_merge`, `token_bucket`). Across the three samples
(C1.2 4/6, C2.2 4/6, C7a 5/6) exactly three tasks are solved every time (`deadline_queue`, `dep_order`,
`token_bucket`), `route_match` is never solved, and `csv_schema` and `hunk_merge` flip. The tier's resolution at
this build is therefore **3 stable + up to 2 coin-flips**, and no single-task story about it should be read as
structural — including iteration 1's.

### 7.3 Why warm loses them — a defect, with the cold run beside it

Same task, same build, same step-1 batch of 185 candidates, three of which diverge:

```
warm OFF  verify · g1: 185 tested on 8 lanes (182 unchanged, 3 timeout); … test wall left 65 s; run median  510 ms, t_run  510 ms
warm ON   verify · g1: 185 tested on 8 lanes (182 unchanged, 3 timeout); … test wall left 57 s; run median 11655 ms, t_run 11655 ms; warm 185/185, screen 84973 ms, 3 deadline rechecks cold
```

and four batches later, with the step's test wall spent:

```
warm ON   verify · g1: 0 tested on 8 lanes (nothing ran); runs left 16, test wall left 11 s · 0 candidates, 0 tested      (× 12)
```

**The estimator is sampled from the tail.** `src/synth/sieve/runner.ts:847` deliberately teaches the oracle from
cold runs only — *"Only COLD runs teach the oracle. `tRunMs` sizes lane timeouts, the SIEVE/RANK plan and the load
scaling, all of which are statements about a fresh process"* — by pushing a duration into `subsetDurations` under
`if (mode === 'first' && !sub.warm)`. That is right when cold is the whole batch. It is wrong when the plane is on,
because the **only** candidates that reach the cold path are the ones whose hot screen hit a deadline the baseline
does not hit: `runner.ts:740-750` computes the hot summary, and if `newDeadlineHit(sum, baseline)` it discards the
verdict, calls `warm.deadlineRecheck()` and falls through to the cold run. So with warm on, `subsetDurations` is a
sample of **nothing but timeouts** — three of them here — and `median(subsetDurations)` (`runner.ts:1042`) is
11,655 ms instead of 510 ms. `refineTRun` writes that into `oracle.tRunMs.goalSubset`, which sizes `laneTimeoutMs`,
`minRunWallMs` (`runner.ts:666`) and the SIEVE/RANK run plan, and the step now budgets every future run at ~12 s.
Four batches later `runs left` has collapsed from 1,315 to 16 and nothing can be dispatched.
`shortest_path_length` shows the identical pattern (`run median 12242 ms` hot against 869 ms cold, 2 rechecks).

A second, smaller cost compounds it: the hot screen is bounded by the **lane run cap**
(`runner.ts:736` passes `capMs() = min(runTimeoutMs, wallLeft())`), not by the sieve's adapted **per-case** timeout
that the cold path uses via `oracleFor(s).perTestTimeoutMs` (`case timeout 500→1426 ms` in the cold transcripts),
so a diverging candidate burns ~14 s hot and is then re-run cold — the step pays both.

This is not the FIFO wedge and not a watchdog gap; it is a calibration-sampling defect in the screen path, and it
only appears when a batch contains a diverging candidate — which is why QuixBugs `topological_ordering` and
`shortest_path_length` hit it and the ladder tier does not.

### 7.4 Recommendation: **keep the default OFF**

The criterion was written before the matched pair ran and is reproduced verbatim in `llm-jev-iter2.tool.md` §6.2.
It required all four of: (1) safety — zero wedges, zero `disabledReason`, zero fallbacks/restarts/mismatches;
(2) pass parity — warm-on ≥ warm-off, and `c = 0` on the matched pair; (3) wall — matched-pair median ratio
≤ 0.90 and faster on a majority; (4) Ring 1 passes with the plane on.

| criterion | result |
|---|---|
| 1 safety | **met** — 93,460/93,460 screened, 0 fallbacks, 0 restarts, 0 mismatches, 0 `disabledReason`, 0 wedges |
| 2 pass parity | **not met** — `c = 1` on the matched pair (`topological_ordering`), 4 cold-wins against 2 warm-wins over 54 paired tasks, and the QuixBugs loss reproduced |
| 3 wall | **met** — median 0.767, faster on 7/7, at a *higher* recorded load |
| 4 Ring 1 with the plane on | **not met** — still FAILs the ladder `--jev off` gate on `units` (identically with the plane off, so not warm's fault, but the condition in `docs/DECISIONS.md` is unmet) |

**Keep `JEVCODE_WARM` off by default.** The plane is worth turning on once §7.3 is fixed — a 23 % wall reduction on
the one-line regime at zero transport failures is the largest single win in this document — but a default that
loses a task the cold path solves, reproducibly, is not a default. The fix is small and testable offline: keep a
deadline-recheck run out of `subsetDurations` (it is a timeout, not a measurement of a fresh process), and give
`warm.serve` the sieve's adapted per-case timeout rather than the lane run cap. Re-run C6 after it; if `c = 0` and the ratio holds, flip the default and re-check Ring 1 separately.


## 8. Question (c): predicted versus observed, per iteration-2 change

| # | change (commit) | predicted | observed | held? |
|---|---|---|---|---|
| 9 | `doneClaimEscalation` — a refused `done:` completion claim climbs `PHASE_ESCALATION` before any move may end the run (`9a161a1`, `10b56ce`, `src/loop/stages/replan.ts:212`) | the SWE 5-step `replan_stop` and `django__django-15128` were this deadlock, not change 7 | fires **8×** on the fresh 18, **3×** in-sample, **1×** in C5, always as `done proposal → change_approach escalation=SEEDS → SKETCH/WIDENED`; no run reached the exhausted-ladder stop. SWE `replan_stop` moves from **4 runs at exactly 5 steps / 60–100 s** to **14, 17, 14 steps / 282, 643, 622 s** (the fourth is `max_replans` at 21), and **2 of 4 now pass**. `django__django-15128` ends `complete` at 6 steps and passes | **yes — the diagnosis was right** |
| 1′ | `rankPoolCap` on the repository best-guess RANK site (`39de7cb`, `src/synth/search/subgoal.ts:1611`, `budget.ts:243`) | 6,960 priced / 20 tested → what the step can run | fresh SWE **751 priced / 1,060 tested** (was 6,960 / 20 — a 348× pricing overhang becomes 0.71×); warm arm 457 / 544; in-sample SWE 295 / 538. Pooled fresh `ranked / tested` 2,302 / 27,559 against iteration 1's 8,806 / 29,297, and Jev requests on the fresh slice fall 1,086 → **877** at **more** work done | **yes** |
| 3′ | per-goal deadline high-water mark, served-p90 excludes unserved samples (`11f169e`, `src/synth/llm/source.ts:217`) | a zero-token timeout never lowers the next deadline | **no goal's deadline shrank after a zero-token timeout in any of the six arms** (0 of 45 `llm:deadline` events). Zero-token timeouts fall to **69 of 254 fresh samples (27.2 %, was 46.6 %)** and **15 of 218 in-sample (6.9 %, was 33.6 %)**; their share of sample-seconds falls to **40.9 % (was 63.6 %)** and **19.8 % (was 46.0 %)** | **yes — the mechanism is exact; the residual 27 % is not fixed** |
| 8′ | the localiser falls through to code order on an all-escape `Choice` (`0d61eef`, `src/synth/localize/index.ts`) | `--jev off` no longer parks at zero sites; Ring 1's `gcd`/`mergesort`/`units` losses go | Ring 1's **QuixBugs gate passes** with the plane off (Jev-on 1/3 → off 2/3) and with the plane on (3/3 → 3/3): `gcd` and `mergesort` are recovered. The **ladder gate still FAILs on `units`** in both runs | **half — 2 of the 3 named tasks** |
| — | (scoped but **not landed**): the thresholdless rule for the `token_bucket` overfit | — | `token_bucket` is a strong overfit again; no `src/synth` guard/arbitration file changed in `9292d44..d86c385` | **not attempted** |
| — | (scoped but **not landed**): the one-line-regime slowdown | — | at matched load `llm-jev` is 1.163× the tuned wall on the 8 both solved (§6), slower on 6/8 | **not attempted** |

Two iteration-1 findings that are *unchanged* and worth restating: change 2's cache is still countable and exact
(`jevCacheHits` 290 = the `cached` rows, 33.1 % of fresh requests; 205 = 24.4 % in-sample), and change 4 still
holds — QuixBugs is one goal on every one of the 34 QuixBugs runs across all arms, and **no site-budget split fired** on
the fresh slice; in-sample, two split goal ids appear on one task (`account`) — the first ever recorded.

## 9. Ring 1 and Ring 2 (`experiments/harness-next/quick.mts`)

**Ring 1 — the `--jev off` safety gate ($0), run twice.** With `JEVCODE_WARM=off`: QuixBugs **pass**
(`Jev on 1/3 pass → off 2/3`), ladder **FAIL** (`Jev on 2/2 → off 1/2; lost units`; the false-green signature,
"replanned into the cap"). With `JEVCODE_WARM=on`: QuixBugs **pass** (`3/3 → 3/3`), ladder **FAIL** on `units`
again. Overall `quick: a gate failed (git d86c385)` in both runs. Against iteration 1 (`gcd`, `mergesort` **and**
`units` all lost, QuixBugs gate FAIL) this is two of three tasks recovered and the gate half-fixed. The
plane-on run is itself a result: it **completed in 12.5 minutes**, where iteration 1's plane-on Ring 1 reached one
step in twelve minutes and had to be killed.

**Ring 2 — the five tiny live tasks ($0.0048 of a $0.05 cap): 5/5 pass, REJECT**, the same verdict as iteration 1
and for one of the same reasons.

```
  task            pass  steps   wall      wall/step    $        jev req  jevMs   harnessMs  verdict     vs baseline
  gcd             true      2    20.4 s     10.2 s   $0.0002        3 750.9 ms   137.3 ms  —           +27 %
  kth             true      2    31.7 s     15.9 s   $0.0003        3 574.8 ms   107.1 ms  —            -4 %
  mergesort       true      6   110.8 s     18.5 s   $0.0026       29    4.8 s   195.2 ms  —           -38 %
  tagcloud        true      2     8.7 s      4.3 s   $0.0004        9    1.9 s   191.1 ms  —           -21 %
  units           true      6   241.3 s     40.2 s   $0.0013       26    5.5 s   338.8 ms  —          +997 %

    median wall −≥ 10 % on ≥ 3 tasks           2/5  NOT met      (iteration 1: 3/5 met)
    no verdict changed                          0 change(s)  met
    overfit count not increased (baseline 5)    0  met
    Jev requests not increased                  1 task(s) up  NOT met
  REJECT — and run it twice before believing it
```

Ring 2 ran at loadavg 13.6 rising through the run, so the `+997 %` on `units` and the `+27 %` on `gcd` are not
build numbers; the two `NOT met` rows are what the rule says, and the rule was not re-run twice.


## 10. Defects found while measuring

1. **The warm counters are unobservable from a bench run.** `WarmStats` — `disabledReason`, `fallbacks`,
   `restarts`, `mismatches`, `screenMs` — exists only as the free-text clause `warmNote(warmStats)` appends to the
   sieve's `synth · verify` event (`src/synth/sieve/runner.ts:1065`, `src/synth/warm/plane.ts:368`). It is in no
   archived record: `steps.jsonl`'s `verify` object has no warm field, `SearchTrace` has none, and
   `--archive-runs` does not copy `transcript.log`. `src/synth/search/types.ts:129-141` documents this as a known
   gap. **Consequence:** the A/B this measurement was asked for could not be audited from the committed artefacts
   at all; every warm number here comes from transcripts harvested out of `~/.jevcode/runs/<runId>/` by hand
   before the next arm overwrote the working set. Wiring the counters into `SearchTrace` is, as that comment says,
   "a field and an assignment".
2. **`timing.jevWallMs` is declared and never persisted.** `src/loop/engine.ts:440` declares it on the step
   timing and `:427` documents it as "the wall the engine actually spent inside `decider.ask`", but neither
   `state.json` nor `steps.jsonl` carries the key (`grep -c jevWallMs` over both archives: 0). The S0 timeline
   buckets that *are* recoverable are `generatorMs`, `jevMs`, `execMs`, `harnessMs`, `synthMs`, `imagesMs`,
   `totalMs`.
3. **The `t_run` calibration sample is selected by failure when the warm plane is on** — §7.3, with
   `src/synth/sieve/runner.ts:847` (`if (mode === 'first' && !sub.warm)`) and `:740-750` (`newDeadlineHit` →
   `deadlineRecheck()` → cold). This is the reason for the recommendation in §7.4 and is the one code change this
   measurement asks for.
4. **`JEVCODE_WARM=on` silently does nothing on SWE-bench** (`warmModeFor`, `src/synth/warm/plane.ts:122`, admits
   only the `quixbugs` and `pytest` runners; the SWE oracle's runner is `other`). Not a bug, but it means "the
   warm A/B on the measured 18-task slice" is really an A/B on 14 of them, and nothing in the output says so.

## 11. What this does and does not settle

**Settled.** Iteration 2's four landed changes are measurable and three of them do exactly what they were written
to do: the refused-`done:` deadlock was the real cause of both the SWE five-step stop and `django__django-15128`,
and removing it moves repositories from 0/4 to 2/4 and recovers the in-sample regression; `rankPoolCap` ends the
348× pricing overhang on repositories; the deadline high-water mark is exact (zero shrinks in 45 events) and cuts
zero-token timeouts by 41 % of samples on the fresh slice and by 79 % in-sample. On a slice nobody tuned against,
`llm-jev` is 14/18 against a tuned generator's 9/18 with **b = 5 / c = 0, sign p = 0.0312** — iteration 1's
direction, now at conventional one-sided significance on n = 18. `detect_cycle` is correct. The warm plane's
transport fault is gone and, where it engages, the plane is 23 % faster at matched load.

**Not settled, and not claimed.** n is still 18 and 28 and there is still no repeat of any arm except QuixBugs.
Ladder long-2 scores 4/6, 4/6 and **5/6** in three runs of this build on this day: three tasks always solve,
`route_match` never does, and `csv_schema` and `hunk_merge` flip — the tier's resolution is **3 stable plus up to
two coin-flips**, so neither iteration 1's 4/6 nor this report's is a level, and none of the single-task stories
in §5 (`account`, `wrap`, `shortest_path_length` all flip between arms too) should be read as structural.
`token_bucket` is a strong overfit for the third measurement running and the rule for it was never written.
Ring 1 still fails. Ring 2 still rejects. The `jev-off-tuned` ladder and SWE rows are **iteration 1's records, not
re-run** — only QuixBugs has a same-session tuned control (C3/C6c), and the ladder/SWE comparisons therefore span
two builds of the baseline arm as well as two days of machine. Above all: **this measurement was taken on a
machine running at loadavg 3–175 against 15 cores**, and load is not noise for this program — it changes which
tasks finish. Every wall number outside §6 is context, not a result, and two task losses (`account`,
`hunk_merge`) are attributed to it rather than to the build.
