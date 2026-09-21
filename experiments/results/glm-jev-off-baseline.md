# GLM generator-only baseline (`--conditions jev-off`, z-ai/glm-5.3-flash) — 2026-09-21

Purpose: the "just the LLM" side of the head-to-head. The user requires the LLM+Jev mode to be far better and faster than the
generator alone; this run measures the generator-only loop (`jev-off`: same engine, every Jev consumer removed — no intent,
context, risk, judge or replan stage; `done` stops the run as `generator_done`) with the default generator on a fixed task
set, so the later llm+jev run on exactly these 28 tasks and the same model can be compared. Live measurement only; no source
was changed; nothing was committed.

## Setup (verified, not assumed)

- Frozen worktree `/Users/prateekjannu/Documents/vscode/JevCode/.claude/worktrees/baseline-clean`, HEAD `214bf55`
  (includes `2a92d0b`: default generator OpenRouter `z-ai/glm-5.3-flash`); `node_modules` symlinked to the main checkout.
  No `jevcode.json` in the worktree and no `~/.config/jevcode/config.json`, so the generator came from `src/config/defaults.ts`.
- Every command: `env -u ANTHROPIC_API_KEY node --env-file=<main>/.env node_modules/.bin/tsx src/cli/main.tsx bench --live …`
  (`--live` is required for the real provider; `--spend-cap` is required with `--live`). Results were written under the main
  checkout via absolute `--out` paths. No key is printed anywhere in this document or the logs.
- Condition confirmed from the records: every `summary.json` has `conditions["jev-off"].generatorModel = "z-ai/glm-5.3-flash"`
  and `deciderModel = null`; every task record has `jevRequests 0`, `cost.jev 0`, every `steps.jsonl` row has
  `usage.jev.calls 0`, and no run directory contains `jev.jsonl` or `decisions.jsonl`. The first QuixBugs run
  (`20260921-175447-zq57al6a`, bitcount) showed `mode "jev-off"` in `run.json` and `model "z-ai/glm-5.3-flash"` in
  `generator.jsonl` before the rest of the suite was allowed to proceed. `--live` still validates and builds the Jev decider
  (`typesafe/jev-1.13-20260917`, pinned) even for jev-off; it is never called.
- Harness facts that shape the jev-off transcripts (from the frozen source, cited so the behavioural notes are checkable):
  - `generator.maxTokens` default 4096 (`run.json` config: `source: default`); the OpenRouter body sends `max_tokens: 4096`,
    `stream: true`, `parallel_tool_calls: false`, tools with `strict: true`, and no `reasoning` option
    (`src/provider/openrouter.ts` `buildOpenRouterBody`); the stream parser accumulates only `content` and `tool_calls` deltas.
  - The propose stage makes one retry on a malformed reply, appending the tail of the raw text and a correction message
    (`src/loop/stages/propose.ts`, `PROPOSE_MAX_ATTEMPTS`); a second malformed reply fails the step
    (`outcome.status failed`, `error propose: generator_response`), and the step still counts against `--max-steps`.
    Three consecutive failed stages end the run with `stopReason error` (`CONSECUTIVE_STAGE_FAILURE_LIMIT = 3`,
    `src/loop/engine.ts:210`).
  - In jev-off the prompt carries `contextFiles: []` (Jev's context stage is what injects whole files in jev-on) plus a
    candidate file list (`src/loop/engine.ts` ~1839). Step outputs — including the `read` action's file contents — reach the
    generator only through the window: the last `WINDOW_SIZE = 4` steps, each output clipped to `WINDOW_OUTPUT_HEAD = 400`
    + `WINDOW_OUTPUT_TAIL = 200` characters with a `…[N chars omitted]…` marker (`src/loop/window.ts`,
    `src/core/text.ts headTail`). So the generator never sees more than 600 characters of any file or command output per step.
  - The `read` action itself accepts up to 12 paths / 60 KB (`src/loop/stages/execute.ts`), but that content is then clipped
    as above before the model sees it.
  - Bench runs decline every review (`alwaysDecline`) and the per-run spend cap is `--task-spend-cap`.

## Commands, run ids, logs

Run 1 — QuixBugs 10 (`bench/results/glm-jev-off-quixbugs`, benchId `20260921-175447-e8d6f6`, 17:54:47Z → 18:06:56Z, 12 min):

```
cd /Users/prateekjannu/Documents/vscode/JevCode/.claude/worktrees/baseline-clean
env -u ANTHROPIC_API_KEY node --env-file=/Users/prateekjannu/Documents/vscode/JevCode/.env node_modules/.bin/tsx src/cli/main.tsx bench \
  --suite quixbugs --conditions jev-off --live \
  --task-id bitcount,bucketsort,detect_cycle,find_in_sorted,gcd,kth,lis,mergesort,shortest_path_length,wrap \
  --concurrency 4 --max-steps 12 --max-wall 8m --spend-cap 0.6 --task-spend-cap 0.06 \
  --out /Users/prateekjannu/Documents/vscode/JevCode/bench/results/glm-jev-off-quixbugs
# log /tmp/jevonly/glm-off-quixbugs.log ("exit 0")
```

Run 2 — ladder short tier, all 12 (`bench/results/glm-jev-off-ladder`, benchId `20260921-180729-566772`, 18:07:29Z → 18:32:17Z, 25 min):

```
env -u ANTHROPIC_API_KEY node --env-file=/Users/prateekjannu/Documents/vscode/JevCode/.env node_modules/.bin/tsx src/cli/main.tsx bench \
  --suite ladder --conditions jev-off --live --tasks 12 \
  --concurrency 3 --max-steps 25 --max-wall 12m --spend-cap 1.0 --task-spend-cap 0.1 \
  --out /Users/prateekjannu/Documents/vscode/JevCode/bench/results/glm-jev-off-ladder
# log /tmp/jevonly/glm-off-ladder.log ("exit 0"); --tasks 12 selects exactly the twelve short-tier tasks (src/bench/ladder/tasks.ts)
```

Run 3 — SWE-bench Verified, 6 issue-oracle-valid instances (`bench/results/glm-jev-off-swebench`, benchId `20260921-183246-5e025c`, 18:32:46Z → 19:33:06Z, 60 min):

```
NODE_OPTIONS=--max-old-space-size=8192 env -u ANTHROPIC_API_KEY node --env-file=/Users/prateekjannu/Documents/vscode/JevCode/.env node_modules/.bin/tsx src/cli/main.tsx bench \
  --suite swebench --conditions jev-off --live \
  --task-id sympy__sympy-15345,sympy__sympy-17139,sympy__sympy-19954,sympy__sympy-11618,django__django-15128,django__django-15315 \
  --concurrency 2 --max-steps 25 --max-wall 25m --spend-cap 1.2 --task-spend-cap 0.25 \
  --out /Users/prateekjannu/Documents/vscode/JevCode/bench/results/glm-jev-off-swebench
# log /tmp/jevonly/glm-off-swebench.log ("exit 0"); the bench process stayed at ~1 GB RSS; bare clones reused from ~/.jevcode/runs/bench-cache
```

Verdicts (main checkout, code only, no Jev):

```
cd /Users/prateekjannu/Documents/vscode/JevCode
env -u ANTHROPIC_API_KEY node node_modules/.bin/tsx experiments/inspect/quixbugs-verdicts.mts bench/results/glm-jev-off-quixbugs   # -> bench/results/glm-jev-off-quixbugs/verdicts.md
env -u ANTHROPIC_API_KEY node node_modules/.bin/tsx experiments/inspect/ladder-verdicts.mts   bench/results/glm-jev-off-ladder     # -> bench/results/glm-jev-off-ladder/verdicts.md
```

Both scripts rebuild the committed program from `~/.jevcode/runs/<runId>/model_patch.diff` (their bench-workspace fallback
path is the jev-only one and does not exist for jev-off); every verdict below says "from model_patch.diff".

Per-task run ids (`~/.jevcode/runs/<runId>/` holds `steps.jsonl`, `generator.jsonl`, `transcript.log`, `model_patch.diff`, `run.json`):

- QuixBugs: bucketsort `20260921-175447-oxd3unlo`, find_in_sorted `20260921-175447-frpmc3av`, bitcount `20260921-175447-zq57al6a`,
  kth `20260921-175606-ax26n4xi`, gcd `20260921-175553-lyjwhe2c`, lis `20260921-175621-7eek3rw6`, detect_cycle `20260921-175447-iupu7y46`,
  mergesort `20260921-175626-ao6ao56w`, shortest_path_length `20260921-175647-eannxfyb`, wrap `20260921-175856-ywunu5j6`.
- Ladder: events `20260921-180729-gsrmoprz`, grades `20260921-180918-h5di5zqm`, account `20260921-180729-m5a25yzh`,
  profiles `20260921-181728-dqn4d5xm`, calendar_utils `20260921-180729-roozlt3d`, stats `20260921-181929-5iw3jknf`,
  shipping `20260921-181921-7tr7r44l`, tagcloud `20260921-182056-42d5cbul`, inventory `20260921-181437-zrm5flph`,
  textstats `20260921-182211-zpfzggjp`, units `20260921-182511-hffrqnud`, table `20260921-182017-gegdouu7`.
- SWE-bench: sympy-15345 `20260921-183300-2j5efj2c`, sympy-17139 `20260921-183300-tmralign`, sympy-11618 `20260921-185904-acviwrde`,
  sympy-19954 `20260921-184228-ab2uug37`, django-15128 `20260921-190604-n37ljgyp`, django-15315 `20260921-190746-pgrfdsy3`.

Column notes for the tables: `pass` is the bench evaluator (`run_tests.py` reference cases for QuixBugs, hidden pytest for the
ladder, `local-venv` FAIL_TO_PASS/PASS_TO_PASS for SWE-bench); `verdict` is the inspect script (QuixBugs/ladder only); `gen $`
is `cost.generator` from the record (OpenRouter-reported cost); `in/out tok`, `gen calls`, `malformed` and the per-call latency
are summed over `generator.jsonl` (one row per provider call, retries included); the time split is summed over
`steps.jsonl.timing`.

## 1. QuixBugs 10 — 7/10 pass, all 7 gold-identical

| task | pass | verdict | steps | wall s | gen $ | in tok | out tok | gen calls | malformed | gen s/call mean | max | stop | evaluator reason |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| bucketsort | pass | gold-identical | 5 | 66 | 0.0019 | 9881 | 1431 | 5 | 0 | 13.2 | 56 | generator_done |  |
| find_in_sorted | pass | gold-identical | 4 | 79 | 0.0041 | 10096 | 5762 | 5 | 1 | 15.7 | 33 | generator_done |  |
| bitcount | pass | gold-identical | 4 | 94 | 0.0049 | 14173 | 6018 | 5 | 1 | 18.7 | 62 | generator_done |  |
| kth | pass | gold-identical | 5 | 20 | 0.0023 | 11670 | 1423 | 5 | 0 | 3.9 | 7 | generator_done |  |
| gcd | pass | gold-identical | 4 | 53 | 0.0026 | 7951 | 3371 | 4 | 0 | 13.2 | 24 | generator_done |  |
| lis | pass | gold-identical | 6 | 155 | 0.0116 | 16507 | 18652 | 8 | 3 | 19.3 | 55 | generator_done |  |
| detect_cycle | pass | gold-identical | 4 | 480 | 0.0077 | 12491 | 14453 | 6 | 2 | 79.8 | 367 | wall_time |  |
| mergesort | FAIL | miss | 4 | 480 | 0.0070 | 13230 | 13280 | 6 | 3 | 68.9 | 321 | wall_time | run_tests: passed 1/14, failed 0, errors 13 (timeouts 0), skipped 0; first failure: input [[1,2,6,72,7,33,4]]  |
| shortest_path_length | FAIL | miss | 8 | 480 | 0.0279 | 46469 | 42591 | 15 | 9 | 31.9 | 103 | wall_time | run_tests: passed 2/4, failed 2, errors 0 (timeouts 0), skipped 0; first failure: input test1: Case 1: One pat |
| wrap | FAIL | miss | 10 | 480 | 0.0230 | 44513 | 33084 | 15 | 7 | 23.1 | 136 | wall_time | run_tests: passed 0/5, failed 5, errors 0 (timeouts 0), skipped 0; first failure: input ["The leaves did not s |

Totals (quixbugs): pass 7/10; mean steps 5.4 (median 4); mean wall 239 s (sum 2387 s); generator $0.0930 (summary.json spentUsd.generator $0.0930, jev $0); tokens in 186981 / out 140065; generator calls 74, malformed 26 (35%); latency per call mean 29.5 s, p50 15.6 s, max 367 s, calls >60 s: 7; time split generator 1418 s / exec 4 s / harness 1 s; Jev calls 0, jevRequests 0.
benchId 20260921-175447-e8d6f6; created 2026-09-21T17:54:47.007Z; finished 2026-09-21T18:06:56.381Z; generatorModel z-ai/glm-5.3-flash; capFired None; notRun 0; stopReasons {'generator_done': 6, 'wall_time': 4}

Verdicts (`bench/results/glm-jev-off-quixbugs/verdicts.md`): solved 7/10; gold-identical 7, equivalent 0, overfit 0, unverified 0,
miss 3. The three misses: mergesort and shortest_path_length committed **no patch** (wall_time while still reading);
wrap committed a 387-byte patch that fails 5/5 reference cases.

## 2. Ladder short tier — 9/12 pass, 9/12 correct (6 gold-identical, 3 equivalent)

| task | pass | verdict | steps | wall s | gen $ | in tok | out tok | gen calls | malformed | gen s/call mean | max | stop | evaluator reason |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| events | pass | gold-identical | 8 | 109 | 0.0050 | 20731 | 5363 | 8 | 0 | 13.4 | 44 | generator_done |  |
| grades | pass | gold-identical | 17 | 319 | 0.0181 | 62440 | 21880 | 19 | 2 | 16.7 | 39 | generator_done |  |
| account | FAIL | miss | 25 | 600 | 0.0285 | 103474 | 35061 | 31 | 6 | 19.3 | 108 | max_steps | pytest: passed 9, failed 1, errors 0, skipped 0 (exit 1) |
| profiles | pass | equivalent | 10 | 112 | 0.0063 | 24635 | 6858 | 10 | 0 | 11.1 | 37 | generator_done |  |
| calendar_utils | FAIL | miss | 20 | 720 | 0.0194 | 82421 | 22939 | 22 | 2 | 32.4 | 169 | wall_time | pytest: passed 9, failed 1, errors 0, skipped 0 (exit 1) |
| stats | pass | gold-identical | 6 | 47 | 0.0024 | 14870 | 1828 | 7 | 1 | 6.7 | 19 | generator_done |  |
| shipping | pass | gold-identical | 9 | 95 | 0.0038 | 22884 | 3420 | 9 | 0 | 10.5 | 29 | generator_done |  |
| tagcloud | pass | gold-identical | 6 | 74 | 0.0020 | 14211 | 1664 | 6 | 0 | 12.3 | 30 | generator_done |  |
| inventory | pass | gold-identical | 22 | 633 | 0.0285 | 94075 | 38231 | 27 | 7 | 23.4 | 122 | generator_done |  |
| textstats | pass | equivalent | 14 | 289 | 0.0088 | 48479 | 7849 | 15 | 1 | 19.2 | 139 | generator_done |  |
| units | pass | equivalent | 9 | 391 | 0.0081 | 31448 | 10092 | 10 | 1 | 39.0 | 151 | generator_done |  |
| table | FAIL | miss | 10 | 720 | 0.0085 | 32492 | 11284 | 12 | 2 | 28.3 | 130 | wall_time | pytest: passed 8, failed 2, errors 0, skipped 0 (exit 1) |

Totals (ladder): pass 9/12; mean steps 13.0 (median 10); mean wall 342 s (sum 4110 s); generator $0.1392 (summary.json spentUsd.generator $0.1392, jev $0); tokens in 552160 / out 166469; generator calls 176, malformed 22 (12%); latency per call mean 21.1 s, p50 11.6 s, max 169 s, calls >60 s: 12; time split generator 3711 s / exec 11 s / harness 2 s; Jev calls 0, jevRequests 0.
benchId 20260921-180729-566772; created 2026-09-21T18:07:29.023Z; finished 2026-09-21T18:32:17.638Z; generatorModel z-ai/glm-5.3-flash; capFired None; notRun 0; stopReasons {'generator_done': 9, 'max_steps': 1, 'wall_time': 2}

Verdicts (`bench/results/glm-jev-off-ladder/verdicts.md`): solved 9/12, correct 9/12 (gold-identical: events, grades, inventory,
shipping, stats, tagcloud; equivalent: profiles, textstats, units — differ from gold textually, identical results on the
verdict script's differential probe); overfit 0; miss 3 (account, calendar_utils, table — each committed a partial patch that
still fails 1–2 hidden tests).

## 3. SWE-bench 6 (issue-oracle-valid instances) — 3/6 pass

| task | pass | verdict | steps | wall s | gen $ | in tok | out tok | gen calls | malformed | gen s/call mean | max | stop | evaluator reason |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| sympy__sympy-15345 | FAIL |  | 6 | 560 | 0.0225 | 61276 | 28216 | 9 | 6 | 62.2 | 134 | error | empty model_patch |
| sympy__sympy-17139 | pass |  | 13 | 1500 | 0.0419 | 157216 | 38056 | 19 | 7 | 28.8 | 97 | wall_time |  |
| sympy__sympy-11618 | pass |  | 14 | 393 | 0.0283 | 121396 | 25891 | 17 | 4 | 22.9 | 99 | generator_done |  |
| sympy__sympy-19954 | FAIL |  | 13 | 1500 | 0.0366 | 141359 | 34857 | 18 | 6 | 49.4 | 166 | wall_time | empty model_patch |
| django__django-15128 | FAIL |  | 23 | 1500 | 0.0663 | 252059 | 72714 | 35 | 16 | 41.7 | 367 | wall_time |  |
| django__django-15315 | pass |  | 24 | 1500 | 0.0783 | 257819 | 91042 | 35 | 15 | 42.4 | 156 | wall_time |  |

Totals (swebench): pass 3/6; mean steps 15.5 (median 14); mean wall 1159 s (sum 6953 s); generator $0.2740 (summary.json spentUsd.generator $0.2740, jev $0); tokens in 991125 / out 290776; generator calls 133, malformed 54 (41%); latency per call mean 40.0 s, p50 25.5 s, max 367 s, calls >60 s: 29; time split generator 5300 s / exec 25 s / harness 3 s; Jev calls 0, jevRequests 0.
benchId 20260921-183246-5e025c; created 2026-09-21T18:32:46.788Z; finished 2026-09-21T19:33:06.227Z; generatorModel z-ai/glm-5.3-flash; capFired None; notRun 0; stopReasons {'error': 1, 'wall_time': 4, 'generator_done': 1}

Patch quality against the gold patches (`bench/data/swebench-verified-30.gold.json`):

- **django-15315 (pass)**: the `Field.__hash__` hunk is textually identical to gold (`return hash(self.creation_counter)`),
  applied at step 3; GLM additionally added a regression test in `tests/model_fields/tests.py` (allowed). The remaining 21 steps
  were verification, test-writing and chasing a pre-existing test until the 25-minute wall.
- **sympy-17139 (pass)**: one hunk in `fu.py` at the gold site; GLM guards with `if rv.exp.is_real is False: return rv`, gold with
  `if not rv.exp.is_real` (gold also skips `is_real is None`); F2P passes. Fix landed at step 9 of 13; the run then hit the wall
  while trying to add a test.
- **sympy-11618 (pass, `generator_done` in 393 s)**: different implementation from gold (zero-pads the shorter coordinate tuple
  inside `distance` instead of gold's type-check branch); F2P passes; also added an assertion to `test_point.py`.
- **sympy-15345 (fail, `stopReason error`)**: empty patch; the run ended at step 6 because steps 4, 5 and 6 were each two
  malformed replies (`proposal: missing key "goal"`) — three consecutive failed stages.
- **sympy-19954 (fail)**: empty patch; 13 steps and 25 minutes spent only reading `minimal_blocks` (sed/awk/python printers),
  never edited.
- **django-15128 (fail)**: never edited `query.py`. At step 13 GLM wrote five `.inspect/q*.txt` chunk files into the workspace
  to work around the 600-char window, and those new files (27,532 bytes, 5 hunks) *are* the recorded `model_patch.diff`
  (`patchApplied true`, no fix inside). 16 of its 35 provider calls were malformed.

## Totals across the 28 tasks

| suite | pass | correct (script) | mean steps | mean wall s | sum wall | generator $ | Jev $ | gen calls | malformed | s/call mean (p50, max) |
|---|---|---|---|---|---|---|---|---|---|---|
| QuixBugs 10 | 7/10 | 7/10 | 5.4 | 239 | 2,387 s | 0.0930 | 0 | 74 | 26 (35%) | 29.5 (15.6, 367) |
| ladder 12 | 9/12 | 9/12 | 13.0 | 342 | 4,110 s | 0.1392 | 0 | 176 | 22 (12%) | 21.1 (11.6, 169) |
| SWE-bench 6 | 3/6 | n/a (3 F2P passes) | 15.5 | 1,159 | 6,953 s | 0.2740 | 0 | 133 | 54 (41%) | 40.0 (25.5, 367) |
| **all 28** | **19/28** | 16/22 scripted + 3 SWE | **10.8** | **480** | **13,450 s (3.74 h task-time)** | **$0.5062** | **$0** | 383 | 102 (27%) | — |

Wall-clock of the three bench processes: 12 + 25 + 60 = 97 minutes. Total spend $0.51 of the $3 cap; no bench or per-task cap
fired; `notRun 0` everywhere.

Where the time went (sum of `steps.jsonl.timing` over all 303 steps): generator 10,429 s, command execution 40 s, harness 6 s.
**99.6% of task wall time is waiting on GLM.** Stop reasons: `generator_done` 16, `wall_time` 10, `max_steps` 1, `error` 1.

## Behavioural notes: how the generator-only loop behaves with GLM

Aggregates over every step of the three suites (`steps.jsonl`, 303 steps):

| | QuixBugs (54 steps) | ladder (156 steps) | SWE-bench (93 steps) |
|---|---|---|---|
| action mix | read 20, run 14, edit 8, done 6, failed-propose 6 | run 78, read 44, edit 18, done 9, patch 4, write 1, failed-propose 2 | run 50, read 23, edit 5, done 1, failed-propose 14 |
| step of first edit (per task) | 2,2,2,3,2,2,2 on the passes; none for mergesort / shortest_path_length; 8 for wrap | 5,11,14,6,7,4,7,4,19,7,7,8 | 9, 4, 3 on the passes; never for 15345 / 19954 / 15128 |
| failed actions | 0 | PatchError 4, EditError 2 | FileNotFoundError 1 (`path:557-1000` as a read path) |
| provider calls malformed / total | 26 / 74 | 22 / 176 | 54 / 133 |
| calls stopped at `length` (4096 out tokens) | 20 (all malformed) | 16 (all malformed) | dominant among the malformed |

1. **Latency, not steps, is the binding limit.** 10 of the 28 runs ended on `wall_time`, only 1 on `max_steps`. Median
   provider call 12–26 s; mean 21–40 s; 48 calls over 60 s; the two worst calls took 367 s and 321 s (both `length` stops at
   11–13 tokens/s, i.e. the served rate collapsed to a tenth of its usual ~100 tok/s). `detect_cycle` had the correct
   gold-identical fix in place at step 2 (44 s in) and then spent the remaining 7.5 minutes on two re-reads and one 367-second
   call that never produced a tool call; it passed only because the evaluator judges the workspace, not the run's `done`.
2. **A third of provider calls are malformed, almost always by exhausting `max_tokens`.** 102 of 383 calls (27% overall; 35%
   QuixBugs, 41% SWE-bench) returned no usable `propose_action` call. The signature is `finish_reason length` at exactly 4096
   output tokens (the raw text is not persisted, so what filled the budget cannot be shown — the provider sends no `reasoning`
   option and the parser keeps only content/tool-call deltas). The retry succeeds often enough that only 22 steps were lost
   outright, but every malformed attempt costs a full-length generation (~20–60 s and ~4k output tokens), and it is the main
   reason output tokens (597k) are 35% of input tokens across the run. Error kinds when both attempts fail: "no tool call and
   no fenced json block" (most), `proposal: missing key "goal"`, `expected an object, got null`, `proposal.goal: must not be empty`.
   sympy-15345 died of three such steps in a row.
3. **Reading is the dominant waste, and it is structural.** With no context stage, GLM only ever sees 400+200 characters of any
   file per step, so it re-reads: `account` used 13 steps (cat -n, sed ranges, base64 — exit 64 on macOS with two files — the read
   action again) before its first edit; `inventory` 18 steps; `table` 7 reads of the same four files ("skipping tests so the output
   is not truncated"); sympy-19954 and django-15128 spent all 13 and 23 steps reading and never edited. GLM adapts intelligently
   (`grep -n -A12 'def …'`, `sed -n '500,512p' | cat -n`, `python -c print(open(...).read())`, and in django-15128 writing chunk
   files to read them back) but each probe is another 10–40 s call. Even on passes, after an edit GLM typically re-reads the file
   "to see its current state after the step N edit" (11 such reads across QuixBugs+ladder) rather than trusting the `edit applied
   (1 match)` outcome.
4. **The `patch` action never worked; `edit` did.** All four unified-diff patches GLM emitted were rejected by git
   (`corrupt patch at line 10`, `No valid patches in input`, `patch with only garbage at line 4` ×2). Every fix that landed came
   through `edit` (single exact-match replacement) or a `python -c` string replace via `run` (inventory step 21). Two `edit`
   failures: `no match` (table, stale anchor after its own previous edit) and a hallucinated `edit x.py: "test one"`
   (account step 19).
5. **Claims in `done` were honest.** All 16 `done` summaries name a concrete change and a test result that the transcript's
   preceding `run` step actually shows (e.g. "python3 -m pytest -q: 7 passed"); none claimed a pass that the evaluator then
   contradicted. The failure mode is not false claims but running out of wall before `done` (10 runs) — three of those
   (detect_cycle, sympy-17139, django-15315) were already correct in the workspace.
6. **Patch quality when it lands is high.** 7/7 QuixBugs fixes gold-identical; ladder 6 gold-identical + 3 behaviourally
   equivalent, 0 overfit; django-15315 textually identical to gold; sympy-17139 at the gold site with a slightly narrower guard.
   Misses are unfinished work (no edit yet, or one of several hunks) rather than wrong edits — account, calendar_utils and table
   each ended with one or two hidden tests still failing after fixing the other hunks.

Three transcripts per suite, in one line each (full transcripts under the run ids above):

- QuixBugs `kth` (pass, 20 s, 5 steps, $0.002): read 5 files → pytest (1 fail) → edit `kth(above, k - num_lessoreq)` → pytest 7 passed
  → done. This is the loop at its best: every call under 7 s, no malformed reply.
- QuixBugs `shortest_path_length` (miss, 8 min, 8 steps, 15 calls, 9 malformed): read → pytest+cat → read → 2× malformed →
  cat both files → nl/sed of lines 12–30 → 2× malformed → read → interrupted by the wall. Never proposed an edit despite seeing the
  Dijkstra loop three times in 600-char pieces.
- QuixBugs `wrap` (miss, 8 min, 10 steps): 7 steps of reading/pytest with 4 malformed attempts, edit at step 8 (drops the space
  after each break and returns the remainder — the wrong hunk: the reference wants the leading space kept and the last line appended),
  pytest 5 failed at step 9, re-read at step 10, wall.
- Ladder `stats` (pass, 47 s, 6 steps): read → pytest → edit (empty-sequence guard in `median`) → pytest → done; one malformed
  attempt retried in 19 s.
- Ladder `account` (miss, max_steps 25, 10 min): 13 read-ish steps before the first edit (withdraw `>=` → `>` fixed at 14),
  transfer direction fixed at step 21 after a hallucinated `edit x.py` and a corrupt patch; the statement-numbering hunk was
  never reached. 9/10 hidden tests pass.
- Ladder `inventory` (pass, 22 steps, 10.5 min, 7 malformed calls): 18 steps hunting for the elided middle of `inventory.py`
  (cat -n, sed, base64, python print, grep -n ''), edit at 19 (both hunks), a garbage patch at 20, a `python -c` replace at 21,
  done at 22 — gold-identical.
- SWE-bench `django-15315` (pass): correct hunk at step 3 (after 2 read steps), then 21 steps of sed/git-diff verification, a
  regression test, and diagnosing an existing test's `1426 == 1426` failure; 15 of 35 calls malformed; wall at 25 min.
- SWE-bench `sympy-11618` (pass, `generator_done`, 6.5 min): read → grep/sed → malformed → edit (zero-pad) at step 4 → five
  verification runs → test edit → two `bin/test` runs → done.
- SWE-bench `django-15128` (miss): 23 steps, zero edits to `query.py`; created `.inspect/q1..q5.txt` to read the 500-line region
  in chunks, which became the submitted "patch"; 16 of 35 calls malformed.

## Failures, caveats, and things the llm+jev run should watch

- No suite failed on setup; every run produced an evaluated record. The one `stopReason error` (sympy-15345) is a live-model
  behaviour (three consecutive malformed steps), not a harness fault.
- django-15128's `model_patch.diff` is five scratch files, not a fix; `patchApplied true / pass false` is correct but the
  27 KB `patchBytes` should not be read as an attempted fix.
- The verdict scripts' workspace fallback path is jev-only-specific; for jev-off they used `model_patch.diff` throughout, which is
  the same artifact the evaluator judged, so verdicts are on the evaluated code.
- QuixBugs and ladder ran with 4 and 3 concurrent runs against the same provider; the two 5-minute calls both happened while 4
  QuixBugs runs were in flight. The llm+jev run should use the same concurrency so latency is comparable, and should report the
  same per-call latency columns (`generator.jsonl latencyMs`) — wall time is almost entirely provider latency here.
- The GLM pricing rows in `defaults.ts` and OpenRouter's reported cost agree to the cent: $0.093 / $0.139 / $0.274 in
  `summary.json spentUsd.generator` match the per-record sums.

## The bar for llm+jev on these 28 tasks (same model, same flags)

pass 19/28 (QuixBugs 7/10, ladder 9/12, SWE-bench 3/6); correct-by-script 16/22 on QuixBugs+ladder with 0 overfit; mean 10.8
steps (5.4 / 13.0 / 15.5); mean task wall 480 s (239 / 342 / 1,159 s), 10 of 28 runs hitting the wall; $0.506 total
($0.093 / $0.139 / $0.274), Jev $0; 383 provider calls of which 27% malformed; provider latency ≈ 99.6% of wall.
