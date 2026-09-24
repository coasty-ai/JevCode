# llm-jev head-to-head against the GLM generator-only baseline — 2026-09-21

Live measurement of the `llm-jev` arm (docs/LLM-JEV-DESIGN.md: the full engine with the Synthesizer, the generating LLM as a candidate source inside it, Jev localising and arbitrating, shadow lanes verifying) against the committed generator-only baseline `experiments/results/glm-jev-off-baseline.md` (`jev-off`, 19/28) on the same 28 tasks, the same generator `openrouter z-ai/glm-5.3-flash`, the same Jev (`typesafe/jev-1.13-20260917`, recorded on the wire as `jev-1.13.0` — `src/config/resolve.ts:801` names them the same model), the same per-suite limits and concurrency (QuixBugs 4 / ladder 3 / SWE 2). Every bench ran from the frozen worktree `.claude/worktrees/llmjev-clean` at HEAD `626fc40` (llm-jev merged; `node_modules` symlinked) with `env -u ANTHROPIC_API_KEY node --env-file=<main>/.env node_modules/.bin/tsx src/cli/main.tsx bench --live …`; results were written under the main checkout (`bench/results/llm-jev-*`). No source was edited and nothing was committed; no key appears in this document or the logs under `/tmp/jevonly/`.

## 0. Verdict

On the 22 cheap-test tasks (QuixBugs 10 + ladder 12) llm-jev beats the generator alone by a wide margin on every axis the criterion measures except correctness: 22/22 pass against 16/22, every run ends `complete` (the baseline hit its wall 6 times there), the median task takes 33 s / 47 s against 93 s / 289 s (0.36× and 0.16×, one-sided Wilcoxon p = 0.003 and p < 0.001), a solved task costs $0.0027 / $0.0044 against $0.0133 / $0.0155 (0.20× / 0.29×), and GLM produced zero malformed replies in 88 samples where the baseline lost 27 % of 250 calls to `length` stops. It does **not** beat the baseline on correctness — correct-by-verdict is 8/10 + 9/12 = 17/22 against 16/22, with **5 overfits** (2 QuixBugs, 3 ladder; the baseline had 0), every one of them a test-fitting seed or a guarded LLM variant that the guard committed over a general candidate — and on **SWE-bench it loses**: 0/6 as run (a Jev 503/529 outage between 23:31 and 23:34 Z killed three runs) and 1/6 after re-running those three (baseline 3/6; b = 0, c = 2), because on repository tasks the seeds phase consumes the verification budget before the LLM hunks are tested (sympy-17139 as run: 15 distinct LLM candidates, 0 tested), 30 s deadlines and OpenRouter 429s wipe whole LLM rounds (django-15128: 31 of 34 samples timed out), and the guard commits half-fixes that satisfy an L2 reproduction narrower than the hidden test (sympy-15345). Pooled over 28 tasks: pass 23/28 vs 19/28 (b = 6, c = 2), median wall 80 s vs 391 s, $0.30 vs $0.51 total, $0.0131 vs $0.0266 per solved — but three of the four pre-registered criteria fail on at least one suite (criterion 1 on QuixBugs and SWE by the absolute bars, criterion 2 on QuixBugs and ladder, criterion 4 on SWE), and the attribution arms could not be run from this HEAD (`jev-off-tuned` is rejected by the CLI, `llm-sieve` is not wired). The honest one-line reading: the mode is far faster and cheaper and solves more small tasks, its correctness guard is not yet trustworthy, and it does not work on repositories in this build.

## 1. Setup, arms run and arms not run

- Worktree `<repo>/.claude/worktrees/llmjev-clean`, HEAD `626fc40` (`git status`: only the `node_modules` symlink untracked). No `jevcode.json` in the worktree, no `~/.config/jevcode/config.json`; the generator and decider come from `src/config/defaults.ts` (`DEFAULT_JEV_MODEL = typesafe/jev-1.13-20260917`).
- Condition recorded in every `summary.json`: `conditions["llm-jev"] = {mode llm-jev, generatorModel z-ai/glm-5.3-flash, deciderModel jev-1.13.0, generation: {proposer synthesizer, sampleTemperatures [0, 0.8], maxTokens 3000 (double-once on length), reasoning {effort: low}, deadlineMs 20000 / repositoryDeadlineMs 30000, servedRate $0.15/$0.5 per M}}` — the pinned §10.1 parameters, echoed by the synthesizer.
- **`jev-off-tuned`: not run.** `src/cli/args.ts:284` has its own list `CONDITIONS = [jev-on, jev-off, jev-only, llm-jev]`, so `--conditions jev-off-tuned` exits 2 with `--conditions: expected one of jev-on|jev-off|jev-only|llm-jev, got "jev-off-tuned"` before `src/bench/conditions.ts parseConditions` (which does know the arm) is reached. All three tuned suites failed this way at 23:33:44 Z (logs `/tmp/jevonly/glm-jev-off-tuned-{quixbugs,ladder,swebench}.log`), $0 spent. Running it needs a one-line CLI change in a follow-up commit; this report does not make it.
- **`llm-sieve`: not run** (as instructed): `src/synth/index.ts:322` throws `ConfigError("synthesizer: mode \"llm-sieve\" is not wired in this build")`.
- Machine: the baseline ran at load ≈ 2 with the CPU idle while waiting on GLM; llm-jev's 8 verification lanes per run put the 1-minute load at 2–37 on QuixBugs (4 runs), 22–35 on the ladder (3 runs) and 4–12 on SWE (2 runs) (`loadavg` in every llm-jev record). The bench process peaked at 4.49 GB RSS on the SWE suite (sampled every 10 s from `ps`, 99 samples) and 2.48 GB on the re-run; the baseline report notes ≈ 1 GB.

## 2. Smoke (`bench/results/llm-jev-smoke`, gcd + kth, ≤ $0.10)

benchId `20260921-225650-6d489c`, runs gcd `20260921-225650-zalbfinx`, kth `20260921-225650-yeor4mgh`; both **pass** at step 2 (`complete`), 11.9 s and 16.6 s, $0.0012 total. Checked from the records and run dirs: `generatorModel z-ai/glm-5.3-flash`; `generator.jsonl` has per-sample rows (`step 1, sample 0, purpose propose_fix, temperature 0, maxTokens 3000, stopReason tool_calls, malformed false, reasoningTokens 8/19, generationId gen-…`); 3 Jev requests per run (`jev.jsonl`, model `jev-1.13.0`, stages propose ×2 and judge ×1, 7–14 questions); the transcript shows the LLM phase — `synth llm:fire: goal g1 round 1 (quixbugs): 1/4 samples fired, staggered, deadline 20000 ms, max_tokens 3000`, `synth llm:sample: k=0 valid 1821 ms: 0 candidates (tried)` (gcd: GLM's patch was identical to the `argument_swap` seed already run) / `k=0 valid 2931 ms: 1 candidates` (kth), `synth llm:round: 1 fired, 1 valid, 0 malformed …` — the sieve (`synth verify: 176 tested on 8 lanes … 1 plausible` / `449 tested`) and the §6.2 guard decision (`synth grace: a seed passer landed with the LLM round in flight; waited 0 ms of 6000 for sample 0 — no fresh LLM candidate; the seeds decide`). Both committed patches carry `evidence.selection: "sieve"`, `candidatesTested 176 / 449`, and are gold-identical (`return gcd(b, a % b)`; `return kth(above, k - num_lessoreq)`); the evaluator passed both. The LLM source fires and its samples parse; on these two programs the seeds simply win the race.

## 3. Probes (§10.2; `experiments/results/llm-jev-probes.md`, $0.0134 of $0.40)

30 `propose_fix` calls on 10 real prompts (5 QuixBugs, 5 ladder) × 3 samples with `reasoning {effort: low}` at `max_tokens` 3000 (one `length` stop re-issued at 6000, valid): valid 30/31 (97 %, gate ≥ 90 %); `finish_reason` tool_calls 30 / length 1; valid latency p50 2.7 s, p90 25.6 s, all-calls p90 60 s and max 171 s (two `bitcount` calls of 114 s and 171 s — the fat tail the 20 s / 30 s deadlines cut); latency fit 6.6 s + 16.4 ms per output+reasoning token; 266 reasoning tokens per call; served providers Wafer, CoreWeave, OpenInference, Together; `usage.cost` $0.00042 per call, 0.89× the served-rate estimate. Anchoring 58/58 hunks (0 % misanchored, gate ≤ 10 %). Diversity 63 % distinct patches per round (gate ≥ 50 %). Cancellation billing: 3 samples aborted at 2 s were billed 0.59× the full-price estimate. `reasoning: {enabled: false}` was not re-issued (HTTP 400 on this endpoint, `llm-jev-probes-off.md`). Nothing in the probes said the mode was broken; the head-to-head proceeded.

## 4. Pooled table — the 28 paired tasks

| arm | pass (Wilson 95 %) | correct-by-verdict (QuixBugs+ladder) + SWE | wall median | wall mean | wall sum | steps mean | $ total (gen + Jev) | $ / task | $ / solved | Jev requests | wall_time stops | patchEmpty |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| jev-off (baseline, committed) | **19/28** [49 %, 82 %] | 16/22 (0 overfit) + 3/6 SWE | 391 s | 480 s | 13450 s | 10.8 | $0.5062 ($0.5062 + $0.0000) | $0.0181 | $0.0266 | 0 | 10 | 4 |
| jev-off-tuned | not run (CLI rejects the arm, §1) | — | — | — | — | — | $0 | — | — | — | — | — |
| llm-jev, as run | **22/28** [60 %, 90 %] | 17/22 (5 overfit) + 0/6 SWE | 80 s | 126 s | 3541 s | 3.6 | $0.2704 ($0.0695 + $0.2010) | $0.0097 | $0.0123 | 741 | 0 | 5 |
| llm-jev, SWE outage runs replaced by the re-run | **23/28** [64 %, 92 %] | 17/22 (5 overfit) + 1/6 SWE | 80 s | 114 s | 3183 s | 3.6 | $0.3024 ($0.0715 + $0.2309) | $0.0108 | $0.0131 | 838 | 0 | 2 |

Discordant pairs pooled (llm-jev wins b, baseline wins c, both, neither): as run b = 6, c = 3, both 16, neither 3; with the re-run b = 6, c = 2, both 17, neither 3. The baseline's wall sum was 13,450 s (3.74 h of task time); llm-jev's 3,541 s as run / 3,183 s with the re-run. Wall-clock of the bench processes: baseline 12 + 25 + 60 = 97 min; llm-jev 3.9 + 6.0 + 16.6 min (+ 9.6 min re-run) = 26.5 (36.1) min.

`llm-sieve` is not in the table (not wired). Correct-by-verdict counts gold-identical + equivalent from `experiments/inspect/{quixbugs,ladder}-verdicts.mts` (both rebuilt the program from `~/.jevcode/runs/<runId>/model_patch.diff`); SWE correctness = evaluator pass.

## 5. Per suite

### 5.1 QuixBugs 10 (12 steps / 8 min / $0.06 per task, concurrency 4)

| task | jev-off | verdict | steps | wall | $ | llm-jev | verdict | steps | wall | $ (gen + Jev) | Jev req | committed by | stop |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| bitcount | pass | gold-identical | 4 | 94 s | $0.0049 | **pass** | gold-identical | 3 | 92 s | $0.0011 ($0.0008 + $0.0003) | 4 | sieve,sieve | complete |
| bucketsort | pass | gold-identical | 5 | 66 s | $0.0019 | **pass** | gold-identical | 2 | 30 s | $0.0004 ($0.0001 + $0.0003) | 3 | sieve,sieve | complete |
| detect_cycle | pass | gold-identical | 4 | 8m00s | $0.0077 | **pass** | overfit | 3 | 34 s | $0.0005 ($0.0000 + $0.0005) | 12 | sieve,sieve | complete |
| find_in_sorted | pass | gold-identical | 4 | 79 s | $0.0041 | **pass** | gold-identical | 2 | 26 s | $0.0004 ($0.0001 + $0.0003) | 3 | sieve,sieve | complete |
| gcd | pass | gold-identical | 4 | 53 s | $0.0026 | **pass** | gold-identical | 3 | 16 s | $0.0005 ($0.0002 + $0.0003) | 4 | sieve,sieve | complete |
| kth | pass | gold-identical | 5 | 20 s | $0.0023 | **pass** | gold-identical | 3 | 33 s | $0.0007 ($0.0003 + $0.0004) | 4 | sieve,sieve | complete |
| lis | pass | gold-identical | 6 | 2m34s | $0.0116 | **pass** | equivalent | 3 | 93 s | $0.0023 ($0.0005 + $0.0018) | 8 | llm,llm | complete |
| mergesort | FAIL | miss | 4 | 8m00s | $0.0070 | **pass** | gold-identical | 3 | 2m58s | $0.0140 ($0.0019 + $0.0121) | 36 | rank,rank | complete |
| shortest_path_length | FAIL | miss | 8 | 8m00s | $0.0279 | **pass** | gold-identical | 3 | 2m49s | $0.0055 ($0.0019 + $0.0036) | 28 | llm,llm | complete |
| wrap | FAIL | miss | 10 | 8m00s | $0.0230 | **pass** | overfit | 2 | 64 s | $0.0014 ($0.0010 + $0.0004) | 4 | llm,llm | complete |

Totals: jev-off pass 7/10 [40 %, 89 %], correct 7 (0 overfit), wall median 94 s / mean 239 s, steps mean 5.4, $0.0930 (per task $0.0093, per solved $0.0133), 4 wall_time stops, stops {'generator_done': 6, 'wall_time': 4}. **llm-jev** pass 10/10 [72 %, 100 %], correct 8 (2 overfit), wall median 34 s / mean 74 s, steps mean 2.7, $0.0267 = generator $0.0068 + Jev $0.0199 (per task $0.0027, per solved $0.0027), Jev requests 106, stops {'complete': 10}. Discordant: b = 3, c = 0, both 7, neither 0.

Pre-registered criteria as evaluated by `experiments/llm-jev/headtohead.mts` (`experiments/results/llm-jev-headtohead.tool.md`):

- criterion 1 — pass (discordant pairs): **FAIL** — n = 10: b = 3 (llm-jev wins), c = 0 (jev-off wins), both 7, neither 0; bar b − c ≥ 8 ∧ c ≤ 2; sign test p = 0.125
- criterion 2 — correct-by-verdict: **FAIL** — llm-jev 8 vs jev-off 7 correct of 10 (Δ +1, bar ≥ +8)
- criterion 3 — wall (median per task): **pass** — median 33s vs 1m33s (0.36×, bar ≤ 0.5×); one-sided Wilcoxon signed-rank p = 0.003 over 10 non-tied pairs (bar < 0.05)
- criterion 4 — cost ($ per solved, $ per task): **pass** — $ per solved $0.0027 vs $0.0133 (0.20×, bar ≤ 0.75×); $ per task $0.0027 vs $0.0093 (0.29×, bar ≤ 1×)
- criterion S1 — refused steps (blocked + declined) on the candidate: **pass** — 0 (bar 0)
- criterion S2 — patchEmpty ≤ baseline: **pass** — 0 vs 2
- criterion S3 — zero modelDrift on the candidate: **pass** — 0 record(s) with drift (excluded from the pairs)

Verdicts (`bench/results/llm-jev-quixbugs/verdicts.md`): gold-identical 7 (bitcount, bucketsort, find_in_sorted, gcd, kth, mergesort, shortest_path_length), equivalent 1 (lis), **overfit 2** — detect_cycle (a seed committed by the sieve with 0 generator calls: passes all 6 reference cases, `detect_cycle(None)` raises AttributeError where the reference returns False, 1/500 random lists) and wrap (the LLM sample the guard arbitrated in: `if text: lines.append(text)` — `wrap("", 140)` returns `[]`, the reference `[""]`; 3/24 perturbed inputs differ). The baseline's 7 passes were all gold-identical; its 3 misses (mergesort, shortest_path_length: no patch at the wall; wrap: wrong hunk) are all llm-jev passes, two of them gold-identical.

### 5.2 Ladder short tier 12 (25 steps / 12 min / $0.10, concurrency 3)

| task | jev-off | verdict | steps | wall | $ | llm-jev | verdict | steps | wall | $ (gen + Jev) | Jev req | committed by | stop |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| events | pass | gold-identical | 8 | 1m48s | $0.0050 | **pass** | gold-identical | 2 | 48 s | $0.0011 ($0.0008 + $0.0003) | 7 | sieve,sieve | complete |
| grades | pass | gold-identical | 17 | 5m19s | $0.0181 | **pass** | gold-identical | 2 | 25 s | $0.0011 ($0.0008 + $0.0003) | 8 | llm,llm | complete |
| account | FAIL | miss | 25 | 9m59s | $0.0285 | **pass** | equivalent | 5 | 2m55s | $0.0171 ($0.0012 + $0.0158) | 50 | sieve,sieve,llm,llm | complete |
| profiles | pass | equivalent | 10 | 1m51s | $0.0063 | **pass** | gold-identical | 2 | 20 s | $0.0007 ($0.0004 + $0.0003) | 7 | sieve,sieve | complete |
| calendar_utils | FAIL | miss | 20 | 12m00s | $0.0194 | **pass** | equivalent | 6 | 2m43s | $0.0034 ($0.0022 + $0.0012) | 25 | sieve,sieve,sieve,sieve,sieve,sieve | complete |
| stats | pass | gold-identical | 6 | 47 s | $0.0024 | **pass** | overfit | 2 | 20 s | $0.0014 ($0.0009 + $0.0004) | 8 | sieve,sieve | complete |
| shipping | pass | gold-identical | 9 | 95 s | $0.0038 | **pass** | overfit | 3 | 80 s | $0.0016 ($0.0000 + $0.0016) | 11 | sieve,sieve | complete |
| tagcloud | pass | gold-identical | 6 | 74 s | $0.0020 | **pass** | equivalent | 2 | 11 s | $0.0005 ($0.0001 + $0.0004) | 9 | sieve,sieve | complete |
| inventory | pass | gold-identical | 22 | 10m33s | $0.0285 | **pass** | equivalent | 4 | 82 s | $0.0019 ($0.0013 + $0.0007) | 16 | sieve,sieve,llm,llm | complete |
| textstats | pass | equivalent | 14 | 4m49s | $0.0088 | **pass** | overfit | 4 | 89 s | $0.0018 ($0.0010 + $0.0008) | 17 | sieve,sieve,llm,llm | complete |
| units | pass | equivalent | 9 | 6m30s | $0.0081 | **pass** | equivalent | 2 | 22 s | $0.0008 ($0.0004 + $0.0004) | 8 | llm,llm | complete |
| table | FAIL | miss | 10 | 12m00s | $0.0085 | **pass** | gold-identical | 4 | 3m06s | $0.0220 ($0.0022 + $0.0199) | 64 | sieve,sieve | complete |

Totals: jev-off pass 9/12 [47 %, 91 %], correct 9 (0 overfit), wall median 289 s / mean 342 s, steps mean 13.0, $0.1392 (per task $0.0116, per solved $0.0155), 2 wall_time stops, stops {'generator_done': 9, 'max_steps': 1, 'wall_time': 2}. **llm-jev** pass 12/12 [76 %, 100 %], correct 9 (3 overfit), wall median 48 s / mean 77 s, steps mean 3.2, $0.0534 = generator $0.0113 + Jev $0.0421 (per task $0.0044, per solved $0.0044), Jev requests 230, stops {'complete': 12}. Discordant: b = 3, c = 0, both 9, neither 0.

Pre-registered criteria as evaluated by `experiments/llm-jev/headtohead.mts` (`experiments/results/llm-jev-headtohead.tool.md`):

- criterion 1 — pass (discordant pairs): **pass** — n = 12: b = 3 (llm-jev wins), c = 0 (jev-off wins), both 9, neither 0; bar b − c ≥ 3 ∧ c ≤ 1; no p-value (under-powered by design)
- criterion 2 — correct-by-verdict: **FAIL** — llm-jev 9 vs jev-off 9 correct of 12 (Δ +0, bar ≥ +2); overfits 3 (bar ≤ 1)
- criterion 3 — wall (median per task): **pass** — median 47s vs 4m49s (0.16×, bar ≤ 0.5×); one-sided Wilcoxon signed-rank p = 0.000 over 12 non-tied pairs (bar < 0.05)
- criterion 4 — cost ($ per solved, $ per task): **pass** — $ per solved $0.0044 vs $0.0155 (0.29×, bar ≤ 0.9×); $ per task $0.0044 vs $0.0116 (0.38×, bar ≤ 1×)
- criterion S1 — refused steps (blocked + declined) on the candidate: **pass** — 0 (bar 0)
- criterion S2 — patchEmpty ≤ baseline: **pass** — 0 vs 0
- criterion S3 — zero modelDrift on the candidate: **pass** — 0 record(s) with drift (excluded from the pairs)

Verdicts (`bench/results/llm-jev-ladder/verdicts.md`): gold-identical 4 (events, grades, profiles, table), equivalent 5 (account, calendar_utils, inventory, tagcloud, units), **overfit 3** — shipping (strong: the seed `cost = 0.0 if subtotal ** 2 >= CONFIG["free_over"] else rate` fits all 10 visible tests; `shipping_cost(49.5, "standard")` → 0.0 vs gold 4.99; the LLM round was 3/3 `openrouter HTTP 429` so the seeds decided alone), textstats (strong: the seed `tokens.append(n)` inside `ngrams` — the same overfit jev-only committed — mutates the caller's list and raises on tuples, 20/94 inputs differ; the LLM sample timed out at 20 s and the guard committed with its own reading "escape 0.86, max general 0.12"), stats (exception class only: the guard chose the seed template `if not ordered: raise ValueError` inserted after the odd-length `return`, so `median(None)` raises TypeError instead of ValueError; the LLM candidate was in the same cluster and lost the arbitration). The baseline's 9 passes were 6 gold-identical + 3 equivalent with 0 overfit; its 3 misses (account, calendar_utils, table) are llm-jev passes (equivalent, equivalent, gold-identical).

### 5.3 SWE-bench Verified 6 (25 steps / 25 min / $0.25, concurrency 2, `NODE_OPTIONS=--max-old-space-size=8192`)

As run (`bench/results/llm-jev-swebench`, benchId `20260921-231705-17879b`, 23:17:05 → 23:33:43 Z):

| task | jev-off | verdict | steps | wall | $ | llm-jev | verdict | steps | wall | $ (gen + Jev) | Jev req | committed by | stop |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| sympy__sympy-15345 | FAIL |  | 6 | 9m19s | $0.0225 | FAIL |  | 2 | 2m37s | $0.0041 ($0.0013 + $0.0028) | 17 | sieve,sieve | complete |
| sympy__sympy-17139 | pass |  | 13 | 25m00s | $0.0419 | FAIL |  | 5 | 16m19s | $0.0576 ($0.0131 + $0.0445) | 88 | - | error |
| sympy__sympy-11618 | pass |  | 14 | 6m33s | $0.0283 | FAIL |  | 9 | 6m31s | $0.0837 ($0.0182 + $0.0655) | 179 | - | replan_stop |
| sympy__sympy-19954 | FAIL |  | 13 | 25m00s | $0.0366 | FAIL |  | 7 | 1m53s | $0.0137 ($0.0041 + $0.0096) | 50 | - | replan_stop |
| django__django-15128 | FAIL |  | 23 | 25m00s | $0.0663 | FAIL |  | 10 | 3m46s | $0.0312 ($0.0147 + $0.0166) | 71 | - | error |
| django__django-15315 | pass |  | 24 | 25m00s | $0.0783 | FAIL |  | 3 | 16 s | $0.0000 ($0.0000 + $0.0000) | 0 | - | error |

Totals as run: jev-off 3/6, wall median 1500 s / mean 1159 s, $0.2740 (per solved $0.0913); llm-jev 0/6, wall median 157 s / mean 314 s, $0.1903 = generator $0.0514 + Jev $0.1389, Jev requests 405, stops {'complete': 1, 'error': 3, 'replan_stop': 2}, patchEmpty 5; discordant b = 0, c = 3, both 0, neither 3.

The three `error` stops are one external event: `Jev HTTP 503: no healthy upstream` (and one `529: high traffic`) from the TypeSafe endpoint, hitting sympy-17139 at steps 3–5 (23:31:41 Z onwards, after 16 minutes and three valid LLM rounds), django-15128 at steps 8–10 and django-15315 at steps 1–3 (started 23:33:27 Z, dead at 23:33:43 with 0 generator and 0 Jev calls). No other run of the day saw a Jev 5xx. Those three tasks were re-run immediately afterwards with the same command and limits into `bench/results/llm-jev-swebench-rerun` (benchId `20260921-233627-abc756`, 23:36:27 → 23:46:04 Z, 0 Jev errors, $0.1209):

| task | llm-jev re-run | steps | wall | $ (gen + Jev) | Jev req | committed by | what was committed | evaluator |
|---|---|---|---|---|---|---|---|---|
| sympy__sympy-17139 | **pass** | 3 | 6m02s | $0.0493 ($0.0072 + $0.0421) | 85 | rank,rank | seed `template/attribute_predicate_guard`: `if not rv.exp.is_comparable: return rv` at fu.py:504 (gold: `if not rv.exp.is_real: return rv` at the same site); arbitrated over 4 passers in 1 cluster, escape 0.03, general 0.51 | pass |
| django__django-15128 | FAIL | 14 | 7m31s | $0.0656 ($0.0204 + $0.0452) | 153 | sieve,sieve | seed `template/guard_empty_return`: `if not other: return self` in `QuerySet.__or__` — passes the L2 reproduction, not the hidden test; 31 of 34 LLM samples timed out at the 30 s deadline over 6 rounds; 3 replan directives | fail |
| django__django-15315 | FAIL | 2 | 49 s | $0.0060 ($0.0023 + $0.0037) | 18 | sieve,sieve | seed `donor/statement_donor`: an unreachable `return (BigAutoField, BooleanField)` appended after `__hash__`'s `hash((...))` — the reproduction passed twice, 24 candidates at the site were flagged `unstable`; the guard committed with its own reading "escape 0.78, max general 0.11"; the LLM's one distinct candidate was in the same cluster and lost | fail |

SWE with the re-run substituted for the three outage records: llm-jev 1/6 [3 %, 56 %] vs jev-off 3/6, discordant b = 0, c = 2 (sympy-11618, django-15315), both 1 (sympy-17139), neither 3; wall median 157 s / mean 254 s vs 1500 s / 1159 s; $0.2223 (generator $0.0535 + Jev $0.1689; per task $0.0371, per solved $0.2223) vs $0.2740 ($0.0457 / $0.0913); Jev requests 502; stops {'complete': 4, 'replan_stop': 2}; patchEmpty 2. On the one task both solved (sympy-17139) llm-jev took 6m02s and 3 steps against the baseline's 25m00s and 13 steps.

Pre-registered criteria, SWE, as run (`llm-jev-headtohead.tool.md`):

- criterion 1 — pass (discordant pairs): **FAIL** — n = 6: b = 0 (llm-jev wins), c = 3 (jev-off wins), both 0, neither 3; bar b − c ≥ 4 ∧ c ≤ 2; sign test p = 1.000 (reported, not gating)
- criterion 2 — correctness: reported (not gating) — SWE: correctness = evaluator pass (criterion 1)
- criterion 3 — wall (tasks solved by both): not evaluable — 0 tasks solved by both: mean wall n/a vs n/a (n/a, bar ≤ 1.0×); mean steps-to-solve n/a vs n/a (n/a, bar ≤ 0.5×)
- criterion 4 — cost ($ per solved, $ per task): not evaluable — $ per solved n/a vs $0.0913 (n/a, bar ≤ 0.75×); $ per task $0.0317 vs $0.0457 (0.69×, bar ≤ 1×)
- criterion S1 — refused steps (blocked + declined) on the candidate: **pass** — 0 (bar 0)
- criterion S2 — patchEmpty ≤ baseline: **FAIL** — 5 vs 2
- criterion S3 — zero modelDrift on the candidate: **pass** — 0 record(s) with drift (excluded from the pairs)

SWE with the re-run substituted (`llm-jev-headtohead.tool-rerun.md`):

- criterion 1 — pass (discordant pairs): **FAIL** — n = 6: b = 0 (llm-jev wins), c = 2 (jev-off wins), both 1, neither 3; bar b − c ≥ 4 ∧ c ≤ 2; sign test p = 1.000 (reported, not gating)
- criterion 2 — correctness: reported (not gating) — SWE: correctness = evaluator pass (criterion 1)
- criterion 3 — wall (tasks solved by both): **pass** — 1 tasks solved by both: mean wall 6m2s vs 25m (0.24×, bar ≤ 1.0×); mean steps-to-solve 3.0 vs 13.0 (0.23×, bar ≤ 0.5×)
- criterion 4 — cost ($ per solved, $ per task): **FAIL** — $ per solved $0.2223 vs $0.0913 (2.43×, bar ≤ 0.75×); $ per task $0.0371 vs $0.0457 (0.81×, bar ≤ 1×)
- criterion S1 — refused steps (blocked + declined) on the candidate: **pass** — 0 (bar 0)
- criterion S2 — patchEmpty ≤ baseline: **pass** — 2 vs 2
- criterion S3 — zero modelDrift on the candidate: **pass** — 0 record(s) with drift (excluded from the pairs)

## 6. Generator per-call behaviour, Jev, memory

**Recording gap that shapes this section.** `generator.jsonl` and `steps.jsonl.usage.generator` hold only the LLM round(s) fired during a run's first step: every later `llm:fire`/`llm:sample`/`llm:round` line is logged under `[step 1]` and its rows are not written (sympy-17139 as run fired 16 samples over three rounds and has 4 rows; its record says `generatorCalls 28` and `cost.generator $0.0131` while the rows sum to $0.0018). Costs in the records are the spend meter's and are complete; the per-call table below is therefore built from the transcripts' `synth llm:sample` / `synth llm:round` lines, which log every sample, with the `generator.jsonl` row count beside it.

| suite | rounds | samples fired (generator.jsonl rows) | valid | timeout (deadline) | cancelled (commit) | error (OpenRouter 429) | malformed | length | distinct candidates | valid samples dropped as duplicate / tried / misanchored | valid latency p50 / p90 / max | round wall p50 | samples per firing step (mean / max) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| QuixBugs llm-jev | 12 | 31 (22) | 23 (74 %) | 6 | 0 | 2 (2) | 0 | 0 | 13 | 14 / 1 / 0 | 10.0 s / 13.4 s / 17.2 s | 31.4 s | 2.4 / 4 |
| ladder llm-jev | 19 | 57 (30) | 30 (53 %) | 12 | 9 | 6 (6) | 0 | 0 | 12 | 18 / 0 / 0 | 8.2 s / 14.4 s / 17.1 s | 23.7 s | 2.7 / 4 |
| SWE llm-jev as run | 17 | 92 (18) | 45 (49 %) | 24 | 12 | 11 (11) | 0 | 0 | 55 | 8 / 1 / 1 | 12.3 s / 26.7 s / 29.3 s | 23.0 s | 3.6 / 4 (first-step rounds; later rounds fire 6) |
| SWE llm-jev re-run | 9 | 48 (12) | 12 (25 %) | 35 | 0 | 0 | 0 | 0 | 12 | 4 / 0 / 0 | 6.8 s / 18.0 s / 28.4 s | 30.0 s | 4.0 / 4 |
| jev-off baseline (all 383 calls, `generator.jsonl`) | — | 383 | 281 (73 %) | 0 | 0 | 0 | 102 (27 %) | 73 | — | — | valid 10.7 s / 43.2 s; all calls p50 17.3 s, p90 69.8 s, max 367 s; 48 calls > 60 s | — | 1 |

Reading: GLM never returned a malformed `propose_fix` (0 of 228 samples) — the structured tool call plus `effort: low` removes the baseline's dominant failure (27 % of calls at `length` 4096). What replaces it is the deadline: 77 of 228 samples (34 %) hit the 20 s / 30 s sample deadline, concentrated on the repository prompts (35 of 48 on the django/sympy re-run; django-15128 alone lost 31 of 34), and 19 samples died of `openrouter HTTP 429: Provider returned error` (shipping 3/3, sympy-19954 2 and 1, sympy-11618 5/6 in one round, django-15128 3/6). Diversity inside the loop is lower than the probe's 63 %: 61 % of valid QuixBugs samples and 60 % of valid ladder samples were dropped as `duplicate` of sample 0's patch. Valid latency (p50 7–12 s) is far above the probe's 2.7 s because the loop's prompts are 2–3× longer and 3–4 samples are in flight per goal.

Jev: 741 requests / 30,927 questions over the 28 as-run tasks (QuixBugs 106 / 2,445; ladder 230 / 5,086; SWE 405 / 23,396 — repository steps ask one "must this file be modified" noul per candidate file and 250-question ranking batches), p50 latency per request 150–280 ms, $0.2010 = 74 % of llm-jev's cost (the design's §8.3 expected Jev to be the minor term; SWE Jev alone is $0.139 as run, $0.231 with the re-run). Jev share of wall (`timing.jevMs` / `wallMs`): 3.7 % QuixBugs, 7.3 % ladder, 8.0 % SWE — inside the 15 % secondary gate; `synthMs` is 99 % / 99 % / 84 % of wall, generator wait 29 % / 30 % / 6 %. RSS: 4.49 GB peak on the SWE suite (2 concurrent runs, 8 worktree lanes each), 2.48 GB on the re-run; the record's `synth.verify` counters are all zero for every task (the real numbers are in `evidence.candidatesTested` and the transcripts — QuixBugs 13,746 candidate runs, ladder 26,948, SWE 2,128 in committed steps).

## 7. Criterion (§1.3 / §10.6), clause by clause

The bars are absolute counts pre-registered for n = 40 / 20 / 30 and `headtohead.mts` applies them verbatim to this 10 / 12 / 6 subset; with the baseline at 7/10, 9/12, 3/6 the largest reachable b − c is 3 on every suite, so QuixBugs criterion 1 (≥ 8) and 2 (≥ +8) and SWE criterion 1 (≥ 4) cannot pass here by construction. The second column is the script's verdict; the third is the same clause read against the bar pro-rated to the subset (QuixBugs ×¼, ladder ×0.6, SWE ×0.2) — that reading is **not** pre-registered and is given only so the numbers can be interpreted.

| clause | script verdict (absolute bars) | pro-rated reading (not pre-registered) |
|---|---|---|
| 1 pass, QuixBugs | **FAIL** — b = 3, c = 0, both 7; bar b − c ≥ 8 ∧ c ≤ 2; sign test p = 0.125 | bar ≥ 2 ∧ c ≤ 0.5 → holds on counts; p = 0.125 does not reach 0.05 at n = 10 |
| 1 pass, ladder | **pass** — b = 3, c = 0, both 9; bar b − c ≥ 3 ∧ c ≤ 1; no p-value by design | holds |
| 1 pass, SWE | **FAIL** — as run b = 0, c = 3; with the re-run b = 0, c = 2, both 1; bar b − c ≥ 4 ∧ c ≤ 2 | fails either way (llm-jev loses two tasks the baseline solved) |
| 2 correct-by-verdict, QuixBugs | **FAIL** — 8 vs 7 (Δ +1, bar ≥ +8) | bar ≥ +2 → fails (Δ +1; 2 overfits) |
| 2 correct-by-verdict, ladder | **FAIL** — 9 vs 9 (Δ 0, bar ≥ +2); **overfits 3 (bar ≤ 1)** | fails on both parts |
| 2 SWE | reported, not gating (= pass) | — |
| 3 wall, QuixBugs | **pass** — median 33 s vs 93 s (0.36×, bar ≤ 0.5×), Wilcoxon p = 0.003 | holds |
| 3 wall, ladder | **pass** — median 47 s vs 289 s (0.16×), Wilcoxon p < 0.001 | holds |
| 3 wall, SWE (tasks solved by both) | as run not evaluable (0 solved by both); with the re-run **pass** — 1 task: 6m02s vs 25m (0.24×, bar ≤ 1.0×), steps 3 vs 13 (0.23×, bar ≤ 0.5×) | n = 1 |
| 4 cost, QuixBugs | **pass** — $ per solved $0.0027 vs $0.0133 (0.20×, bar ≤ 0.75×); $ per task 0.29× (bar ≤ 1×) | holds |
| 4 cost, ladder | **pass** — $ per solved $0.0044 vs $0.0155 (0.29×, bar ≤ 0.9×); $ per task 0.38× | holds |
| 4 cost, SWE | as run not evaluable (0 solved); with the re-run **FAIL** — $ per solved $0.2223 vs $0.0913 (2.43×, bar ≤ 0.75×); $ per task $0.0371 vs $0.0457 (0.81×, bar ≤ 1×) | fails on $ per solved |
| 5 attribution | not evaluable — neither `llm-sieve` (not wired) nor `jev-off-tuned` (CLI rejects the arm) ran | — |
| S1 refused steps = 0 | pass on every suite (0) | |
| S2 patchEmpty ≤ baseline | QuixBugs 0 vs 2 pass; ladder 0 vs 0 pass; SWE as run **FAIL** 5 vs 2, with the re-run pass 2 vs 2 | |
| S3 modelDrift = 0 | pass everywhere | |
| Jev share of wall ≤ 15 % | pass (3.7 % / 7.3 % / 8.0 %) | |

Failed gating clauses, as §10.6 asks them named: **QuixBugs 1 and 2, ladder 2, SWE 1 and 4** (SWE 3 passes only with the re-run and on one task).

## 8. Three transcript walk-throughs — what Jev decided and what GLM wrote

### 8.1 QuixBugs `wrap` (llm-jev run `20260921-230840-mawongzh`, pass by the evaluator, **overfit** by the verdict; baseline `20260921-175856-ywunu5j6`: 10 steps, 8 min, 15 calls / 7 malformed, wrong hunk, FAIL)

- Step 1, code: `synth baseline: 0/5 pass`; goal g1 = the 5 failing cases in `wrap.py`. Jev, `buggy_line` (Choice over the 9 program lines): `line_7` (`line, text = text[:end], text[end:]`) at 0.67; per-line nouls L7 0.62, L4 0.32, everything else ≤ 0.24 — the true defect is a missing statement, which no listed line can name. `synth llm:fire: round 1 (quixbugs): 1/4 samples fired, staggered, deadline 20000 ms`. GLM sample 0 (temperature 0, 11.6 s, 237 output tokens, 95 reasoning): 1 candidate. Seeds at Jev's anchor L7 (mutation 114 + template 132 + donor 73): `304 tested on 8 lanes (292 unchanged, 12 timeout)` — no passer, so `released 3 more samples`. GLM samples 1–3 (5.7 / 8.2 / 9.5 s): one new candidate, two `duplicate`s; `llm:round: 4 fired, 4 valid, 0 malformed, 2 distinct, 39.8 s, $0.0010`. Seeds at the insert sites after/before L7: 227 + 147 tested → 1 plausible seed. `synth grace: a seed passer landed with the LLM round closed … 2 LLM candidates arrived, running them before the decision` → both pass → 3 passers in 3 behaviour clusters (probe 16 inputs, 3/3 signatures).
- Step 1, arbitration: Jev `genuine_fix` (Choice, Q17) over `cand_01` = `L8: lines.append(line)` + `lines.append(text)` before `return` (this is the gold fix), `cand_02` = `L10: if text: lines.append(text)` (GLM sample 3), `cand_03` = insert `while len(text) > cols:` before L7 → **cand_02 at 0.95**; generality nouls cand_01 0.26, cand_02 0.72, cand_03 0.12. Guard: `escape 0.03, max general 0.72; pick llm/sample_3_0 at wrap.py:10:replace`; commit `phase SEEDS, SIEVE, sites 10, requests 3, runs 783`. Risk stage by code: `verified patch — 0→5 of 5 pass, no regressions (llm, 780 tested, arbitrated)`; the patch adds `if text:\n    lines.append(text)` before `return lines`.
- Step 2: `synth baseline: lane run adopted as the baseline (5/5)`; proposal `run python3 -m pytest -q`; intent verify 1.00; judge done 0.92; completion 0.91 → `stop: complete at step 2`, wall 1m03s, $0.0014 (GLM $0.0010, Jev $0.0004, 4 requests).
- Verdict: `quixbugs-verdicts.mts` → **overfit**: `wrap("", 140)` returns `[]`, the reference returns `[""]` (3/24 perturbed inputs differ). Jev preferred the guarded LLM variant over the unguarded gold seed by 0.95 to 0.05 and rated it more general (0.72 vs 0.26); the guard had no differential probe input that distinguished them (`probe 16 inputs, 3/3 signatures` yet the clusters were split by other inputs). This is the arbitration failure class of §9.

### 8.2 Ladder `account` (llm-jev run `20260921-231102-5ah6jrm3`, pass, equivalent; baseline `20260921-180729-m5a25yzh`: max_steps 25, 10 min, 9/10 hidden tests, FAIL)

- Step 1: `synth baseline: 7/10 pass`; Jev picks goal g1 = `test_withdraw_exact_balance_is_allowed` + 1 more in `src/account.py` (`picked by jev`). `llm:fire: round 1 (ladder): 1/3 samples fired, deadline 20 s`; GLM sample 0 (5.6 s) → 1 candidate; seeds at the insert sites L37/L36 (mutation 140, template 38/68, donor 95) return no passer → samples 1–2 released (8.1 s, 8.1 s: both `duplicate`); `llm:round: 3 fired, 3 valid, 1 distinct, 23.9 s, $0.0007`. More seed sites (L54/L53); `guard: arbitrated 2 passers (0 held) in 1 cluster (no probe); escape 0.20, max general 0.39; pick composite/pair_of_partials at src/account.py:36:replace` — a composite of two partial seeds (the `>=`→`>` withdraw bound and a second hunk) — commit after 1,445 runs and 24 Jev requests; risk by code `7→9 of 10 pass, no regressions`.
- Step 2: verification `python3 -m pytest -q` → 9/10 (the ledger: fixed 1, open 1).
- Step 3: goal `test_statement_numbering_starts_at_one` (`picked by single`, class quixbugs → 1/4 samples, deadline now `clamp(2 × p50)` = 16.2 s). GLM sample 0 **timed out at 16.2 s**; seeds at L45/L44 no passer → 3 more samples: sample 1 (7.0 s) 1 candidate, samples 2–3 duplicates; `llm:round: 4 fired, 3 valid, 1 timeout, 1 distinct, 37.7 s, $0.0021`. Seeds at the loop-exit gap after L46 land a passer; `grace … 1 LLM candidate arrived, running them before the decision` → `guard: 2 passers in one behaviour cluster with a code seed and an LLM candidate; committing the LLM member llm/sample_1_0 at src/account.py:44:replace by the preferLlmInCluster rule (no arbitration)` — 9→10 of 10, 1,467 runs, 22 Jev requests.
- Steps 4–5: verify 10/10; completion by the engine's own passing run → `complete`, 5 steps, 2m55s, $0.017 (GLM $0.0012, Jev $0.0158 — 50 requests, the ladder's most Jev-expensive task).
- Verdict: **equivalent** — `account.py` differs from gold at token 245 (`start` vs `1`: GLM numbers the statement from a variable rather than the literal), identical results and post-call state on 81 inputs over 6 functions. The baseline spent 13 read-ish steps before its first edit and never reached the numbering hunk.

### 8.3 SWE-bench `sympy__sympy-15345` (llm-jev run `20260921-231715-th2b5y7n`, `complete` at step 2 but **FAIL** by the evaluator; baseline `20260921-183300-2j5efj2c`: `stopReason error` after three consecutive malformed steps, empty patch, FAIL)

- Step 1, Jev first (repository class): `is_reproduction_0` 0.75 / `shows_expected_0` 0.04 / `shows_actual_0` 0.09 over the issue's code block; `failure_kind` → `wrong_value` 1.0; one "must the file be modified" noul per candidate file — `sympy/printing/mathematica.py` **0.85**, `sympy/parsing/mathematica.py` 0.17, `printing/repr.py` 0.12, everything else ≤ 0.06 (dozens of `bin/*.py`, `doc/*`, `examples/*` at 0.01–0.03). The L2 reproduction `repro::9364c244` is written and confirmed: at base it prints `Max(2, x)` (the issue's wrong output). `llm:fire: round 1 (repository): 4/4 samples fired, deadline 30000 ms`, overlapping the scoped baseline (`142/175 scoped tests pass … in 7.7 s`). GLM samples 0–3 (20.2–22.1 s each, all `tool_calls`): sample 3 → 1 candidate, samples 0/1/2 `duplicate` of it; `llm:round: 4 fired, 4 valid, 1 distinct, 22.1 s, $0.0013`. Seeds at 13 sites: 1,064 candidate runs on 8 worktree lanes, each run = reproduction (≈ 0.9 s) then the scoped regression suite on a passer → 3 passers (2 seeds + the LLM candidate) in **1 cluster**.
- Step 1, guard: `arbitrated 3 passers (0 held) in 1 cluster (no probe); escape 0.18, max general 0.55; pick template/mro_method_alias at sympy/printing/mathematica.py:103:insert` — the seed `_print_Max = _print_Function` (one line, 571-byte diff). Risk by code: `verified patch — 142→143 of 176 pass, no regressions (sieve, 1064 tested, arbitrated)`. The LLM's candidate lost the same-cluster arbitration to a seed.
- Step 2: `lane regression run adopted as the scoped baseline; only the reproduction is re-run` → `reproduction PASSES (Max[2, x])`; proposal `run python bin/test -C --verbose sympy/parsing/tests/test_maxima.py …` (142p/0f/0e, 7.7 s); judge 1.00, completion 0.74 → `stop: complete at step 2`, 2m37s, $0.0041 (GLM $0.0013, Jev $0.0028, 17 requests).
- Evaluator: **FAIL**. The hidden test asserts `mcode(Max(x,y,z)*Min(y,z)) == "Max[x, y, z]*Min[y, z]"`; the alias handles `Max` only, `Min` still prints as `Min(y, z)`; gold adds both to `known_functions`. The reproduction encoded only the issue's `Max` example, so a half-fix satisfied it (failure class D).
- Contrast, the re-run of `sympy__sympy-17139` (`20260921-233639-bagbxrvr`, pass, 6m02s, 3 steps): step 1 GLM 4/4 valid, 6 distinct candidates, but the seeds phase spent the whole run budget (`109 tested: 101 templates, 8 donors`, LLM 0 tested) and the scoped suite takes 39–52 s per regression run; step 2 GLM 6 fired / 2 valid / 4 timeouts; a seed template `if not rv.exp.is_comparable: return rv` at fu.py:504 passed the reproduction, `arbitrated 4 passers in 1 cluster; escape 0.03, general 0.51`, committed; step 3 verified. The evaluator passes it (gold: `if not rv.exp.is_real`). The baseline solved the same task at step 9 of 13 and ran to the 25-minute wall.

## 9. Failure classes for llm-jev misses and overfits

| class | what happens | tasks |
|---|---|---|
| A. The guard commits a test-fitting candidate over a general one | Q17/Q15/Q16 arbitration prefers a guarded LLM variant to the gold seed (wrap: 0.95 vs 0.05), or the sieve commits the lone seed passer with no differential input to reject it (detect_cycle, shipping `subtotal ** 2`), or the guard commits despite reading "max general 0.11–0.12, escape 0.78–0.86" (textstats `tokens.append(n)`, django-15315 dead-code donor) | wrap, detect_cycle, stats, shipping, textstats, sympy-15345, django-15315 (re-run) — 5 overfits + 2 SWE fails |
| B. Seeds starve the LLM lane on repositories | `phase SEEDS / RANK` orders templates and donors ahead of LLM hunks; with a 0.9 s reproduction plus a 12–122 s scoped regression per passer the run budget (13–160 runs) is spent before an LLM hunk is tested — sympy-17139 as run: 15 distinct LLM candidates, 0 tested in two steps; sympy-11618: 16 of 157 runs to LLM hunks, 0 passed; mutation is skipped at repository sites so only new-logic hunks could have worked | sympy-17139 (as run), sympy-11618, django-15128 |
| C. Provider-side losses of whole rounds | OpenRouter `HTTP 429: Provider returned error` (19 samples: shipping 3/3, sympy-19954, sympy-11618 5/6, django-15128 3/6) and the 20 s / 30 s deadlines (77 of 228 samples; django-15128 31/34 across both runs, sympy-11618 6/6 in one round, sympy-19954 2/4 + 2/6, textstats, account step 3) — on the repository prompts GLM's valid latency p90 is 27 s, so the 30 s clamp cuts a third of samples | shipping, textstats, sympy-19954, sympy-11618, django-15128 |
| D. L2 reproduction narrower or less stable than the hidden test | sympy-15345: the reproduction checks the issue's `Max(2, x)` only, the hidden test needs `Min` too; django-15315: a dead-code insertion "passed" the reproduction twice while 24 sibling candidates were flagged `unstable` — `hash()`-dependent reproduction | sympy-15345, django-15315 (re-run) |
| E. Early give-up (`replan_stop`) | after the search parks, the synthesizer proposes `done partial: fixed 0 of 1` three times, Jev directs `gather_context`, the same claim recurs and the run stops (`DESIGN §5.5`) at 1m53s / 6m31s with 23 and 18 minutes of wall unused — cheap, but the baseline used its wall to pass sympy-11618 | sympy-19954, sympy-11618 |
| F. External outage | Jev HTTP 503 / 529 for ≈ 3 minutes killed three runs (`stopReason error`, exit 5); re-run substitutes them | sympy-17139, django-15128, django-15315 (as run) |

Where the LLM did carry the fix (committed `selection: llm`): QuixBugs lis, wrap, shortest_path_length; ladder grades, units and the second hunk of inventory, account, textstats; no SWE task. Where the seeds carried it: 15 of 22 cheap-test commits and all 6 SWE commits (4 of which the evaluator rejected). Cancelled-before-use samples (the LLM lost the race to a seed) cost $0.02 of the $0.07 generator spend.

## 10. Spend, run ids, commands

Spend (records' `spentUsd`): smoke $0.0012; probes $0.0134; llm-jev QuixBugs $0.0267 (GLM $0.0068 + Jev $0.0199); ladder $0.0534 ($0.0113 + $0.0421); SWE as run $0.1903 ($0.0514 + $0.1389); SWE re-run $0.1209 ($0.0298 + $0.0911); jev-off-tuned $0 (did not start). **Total $0.406 of the $6 cap.** No bench or per-task cap fired; `notRun 0` everywhere.

Run ids (`~/.jevcode/runs/<runId>/{transcript.log, steps.jsonl, generator.jsonl, jev.jsonl, decisions.jsonl, model_patch.diff}`):

- llm-jev QuixBugs (benchId 20260921-230708-2bc559, 23:07:08 → 23:11:02 Z): find_in_sorted `20260921-230708-duifw36u`, bucketsort `20260921-230708-t5gtnlgy`, detect_cycle `20260921-230708-qd7mlflv`, gcd `20260921-230735-c3rea5f7`, kth `20260921-230739-ab5mio5h`, bitcount `20260921-230708-qecgvuqn`, lis `20260921-230742-ktcp25mr`, wrap `20260921-230840-mawongzh`, mergesort `20260921-230751-tmpods64`, shortest_path_length `20260921-230812-syzdfktd`
- llm-jev ladder (benchId 20260921-231102-8cca85, 23:11:02 → 23:17:05 Z): events `20260921-231102-hidxrie5`, grades `20260921-231150-xxxygd4i`, inventory `20260921-231215-u46ey43j`, calendar_utils `20260921-231102-eafhmoz7`, account `20260921-231102-5ah6jrm3`, profiles `20260921-231338-olz4b2v5`, stats `20260921-231358-3mgyrxb5`, tagcloud `20260921-231419-57x6rlat`, shipping `20260921-231346-ljxxlpoy`, units `20260921-231507-qjti7hno`, textstats `20260921-231430-zi54zuci`, table `20260921-231358-pvplfhea`
- llm-jev SWE as run (benchId 20260921-231705-17879b, 23:17:05 → 23:33:43 Z): sympy__sympy-15345 `20260921-231715-th2b5y7n`, sympy__sympy-19954 `20260921-232012-kgaythxo`, sympy__sympy-11618 `20260921-232215-xp6alkky`, django__django-15128 `20260921-232914-nyyx6wrq`, sympy__sympy-17139 `20260921-231716-y6lxdq7l`, django__django-15315 `20260921-233327-rvlmadcu`
- llm-jev SWE re-run (benchId 20260921-233627-abc756, 23:36:27 → 23:46:04 Z): sympy__sympy-17139 `20260921-233639-bagbxrvr`, django__django-15128 `20260921-233657-y2aeuf5o`, django__django-15315 `20260921-234432-rpywkq2v`
- Baseline run ids: `experiments/results/glm-jev-off-baseline.md`.

Exact commands (all from the worktree; `<main>` = `<repo>`; the six head-to-head suites were chained sequentially by `/tmp/jevonly/h2h-driver.sh`, logs `/tmp/jevonly/<out>.log` ending in `exit N`):

```
cd <main>/.claude/worktrees/llmjev-clean
# smoke
env -u ANTHROPIC_API_KEY node --env-file=<main>/.env node_modules/.bin/tsx src/cli/main.tsx bench --suite quixbugs --task-id gcd,kth --conditions llm-jev --live --concurrency 2 --max-steps 12 --max-wall 8m --spend-cap 0.1 --task-spend-cap 0.05 --out <main>/bench/results/llm-jev-smoke
# probes
env -u ANTHROPIC_API_KEY node --env-file=<main>/.env node_modules/.bin/tsx experiments/llm-jev/probes.mts --quixbugs 5 --ladder 5 --samples 3 --variants low --cancel 3 --budget 0.40 --out <main>/experiments/results/llm-jev-probes.md --raw <main>/experiments/results/llm-jev-probes.jsonl
# head-to-head, llm-jev (then the same three with --conditions jev-off-tuned --out <main>/bench/results/glm-jev-off-tuned-<suite>, which exit 2 at the CLI)
env -u ANTHROPIC_API_KEY node --env-file=<main>/.env node_modules/.bin/tsx src/cli/main.tsx bench --suite quixbugs --conditions llm-jev --live --task-id bitcount,bucketsort,detect_cycle,find_in_sorted,gcd,kth,lis,mergesort,shortest_path_length,wrap --concurrency 4 --max-steps 12 --max-wall 8m --spend-cap 0.8 --task-spend-cap 0.06 --out <main>/bench/results/llm-jev-quixbugs
env -u ANTHROPIC_API_KEY node --env-file=<main>/.env node_modules/.bin/tsx src/cli/main.tsx bench --suite ladder --conditions llm-jev --live --tasks 12 --concurrency 3 --max-steps 25 --max-wall 12m --spend-cap 1.2 --task-spend-cap 0.1 --out <main>/bench/results/llm-jev-ladder
NODE_OPTIONS=--max-old-space-size=8192 env -u ANTHROPIC_API_KEY node --env-file=<main>/.env node_modules/.bin/tsx src/cli/main.tsx bench --suite swebench --conditions llm-jev --live --task-id sympy__sympy-15345,sympy__sympy-17139,sympy__sympy-19954,sympy__sympy-11618,django__django-15128,django__django-15315 --concurrency 2 --max-steps 25 --max-wall 25m --spend-cap 1.5 --task-spend-cap 0.25 --out <main>/bench/results/llm-jev-swebench
# re-run of the three Jev-outage tasks, same limits
NODE_OPTIONS=--max-old-space-size=8192 env -u ANTHROPIC_API_KEY node --env-file=<main>/.env node_modules/.bin/tsx src/cli/main.tsx bench --suite swebench --conditions llm-jev --live --task-id sympy__sympy-17139,django__django-15128,django__django-15315 --concurrency 2 --max-steps 25 --max-wall 25m --spend-cap 1.0 --task-spend-cap 0.25 --out <main>/bench/results/llm-jev-swebench-rerun
# verdicts and statistics (main checkout, no model calls)
cd <main>
env -u ANTHROPIC_API_KEY node node_modules/.bin/tsx experiments/inspect/quixbugs-verdicts.mts bench/results/llm-jev-quixbugs
env -u ANTHROPIC_API_KEY node node_modules/.bin/tsx experiments/inspect/ladder-verdicts.mts bench/results/llm-jev-ladder
env -u ANTHROPIC_API_KEY node node_modules/.bin/tsx experiments/llm-jev/headtohead.mts bench/results/glm-jev-off-quixbugs bench/results/llm-jev-quixbugs bench/results/glm-jev-off-ladder bench/results/llm-jev-ladder bench/results/glm-jev-off-swebench bench/results/llm-jev-swebench --out experiments/results/llm-jev-headtohead.tool.md
env -u ANTHROPIC_API_KEY node node_modules/.bin/tsx experiments/llm-jev/headtohead.mts <same six dirs> bench/results/llm-jev-swebench-rerun --out experiments/results/llm-jev-headtohead.tool-rerun.md
```

## 11. Caveats and recording gaps (for whoever reads the records)

- n = 10 / 12 / 6 is a quarter to a fifth of the §10.3 design; the absolute bars of §1.3 are not reachable on QuixBugs and SWE here (§7). No QuixBugs repeat run and no per-question ablation were done (not in scope).
- `tasks.jsonl` is written incrementally: each task gets a `stopReason: not_run` placeholder when its run starts and an evaluated record when it ends (last record per task wins; the analysis above drops the placeholders).
- `generator.jsonl` / `steps.jsonl.usage.generator` record only first-step LLM rounds and every LLM line after step 1 is labelled `[step 1]` in the transcript; the record's `generatorCalls` and `cost.generator` are complete (§6).
- `synth.verify` in every record is all zeros; use `evidence.candidatesTested` on committed steps and the `trace` in the `run` fallback's `rawText` for non-committed steps.
- The ladder verdict script counts `stats` as `overfit` for an exception-class difference on `None` input only ("weak only"); the criterion counts it as an overfit all the same.
- `shortest_path_length` and `detect_cycle` (pytest-module tests) were classified `ladder` class by the synthesizer (3 samples per round instead of 4); this does not change their limits.
- The re-run's three SWE records are separate from the as-run directory; `headtohead.mts` with the re-run directory last substitutes them (later dirs win by (suite, task, condition)). Both readings are reported everywhere above.
