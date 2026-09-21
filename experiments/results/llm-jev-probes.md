# llm-jev pre-bench probes (docs/LLM-JEV-DESIGN.md §10.2)

Date 2026-09-21T23:06:10.273Z. Model `z-ai/glm-5.3-flash` through OpenRouter; served rate assumed $0.15/$0.5 per M for the estimates. Prompts: `quixbugs/bitcount`, `quixbugs/bucketsort`, `quixbugs/find_first_in_sorted`, `quixbugs/find_in_sorted`, `quixbugs/flatten`, `ladder/account`, `ladder/calendar_utils`, `ladder/crossfile`, `ladder/events`, `ladder/grades` (user message 769–7121 chars, system 842 chars). 3 samples per round (sample 0 at temperature 0, the rest at 0.8 with per-sample seeds and the class hint schedule). Spent $0.0134 of the $0.4 budget.

## 1. GLM loop probe

| reasoning | calls | valid (parsed, not length) | finish_reason | all p50 / p90 / max | valid p50 / p90 | latency fit | reasoning tokens mean | input p50 / output mean | usage.cost | served provider |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `{effort: low}` | 31 | 30/31 (97 %); 1 re-issued at 2× | tool_calls 30, length 1 | 2.7 s / 60.2 s / 171.4 s | 2.7 s / 25.6 s (n=30) | 6.6 s + 16.4 ms/token (n=30) | 266 | 1245 / 463 | $0.0131 ($0.00042 per call); estimate $0.0147 → billed/estimate 0.89× | Wafer, CoreWeave, OpenInference, Together |

The latency fit is least squares over valid calls with x = output + reasoning tokens (both generated and billed as output; §1.2 says `output_tokens`, identical when no reasoning is sent).

Per prompt (`{effort: low}`, first round):

| prompt | user chars | valid | samples | diversity (4) | anchoring (2) |
| --- | --- | --- | --- | --- | --- |
| quixbugs/bitcount | 769 | 3/3 | tool_calls 171.4s, tool_calls 3.2s, tool_calls 114.0s | 5 patches, 4 distinct (80 %) | 5/5 anchored |
| quixbugs/bucketsort | 940 | 3/3 | tool_calls 1.4s, tool_calls 1.7s, tool_calls 1.6s | 3 patches, 2 distinct (67 %) | 3/3 anchored |
| quixbugs/find_first_in_sorted | 1057 | 2/3 | length 85.2s, tool_calls 25.6s, tool_calls 14.2s | 2 patches, 1 distinct (50 %) | 2/2 anchored |
| quixbugs/find_in_sorted | 927 | 3/3 | tool_calls 1.4s, tool_calls 5.9s, tool_calls 4.5s | 3 patches, 2 distinct (67 %) | 3/3 anchored |
| quixbugs/flatten | 923 | 3/3 | tool_calls 2.6s, tool_calls 60.2s, tool_calls 2.0s | 3 patches, 2 distinct (67 %) | 5/5 anchored |
| ladder/account | 3635 | 3/3 | tool_calls 1.4s, tool_calls 1.4s, tool_calls 2.7s | 3 patches, 3 distinct (100 %) | 9/9 anchored |
| ladder/calendar_utils | 3880 | 3/3 | tool_calls 9.1s, tool_calls 2.8s, tool_calls 10.2s | 3 patches, 1 distinct (33 %) | 9/9 anchored |
| ladder/crossfile | 7121 | 3/3 | tool_calls 2.5s, tool_calls 4.8s, tool_calls 2.7s | 3 patches, 3 distinct (100 %) | 12/12 anchored |
| ladder/events | 3905 | 3/3 | tool_calls 2.7s, tool_calls 2.2s, tool_calls 2.7s | 3 patches, 1 distinct (33 %) | 3/3 anchored |
| ladder/grades | 3842 | 3/3 | tool_calls 1.2s, tool_calls 2.1s, tool_calls 4.0s | 3 patches, 1 distinct (33 %) | 6/6 anchored |

## 2. Anchoring probe

58 hunks from 30 valid samples: 58 anchored, 0 misanchored (0 %; target ≤ 10 %, > 30 % → near_line required and re-probe).

## 4. Diversity

Distinct patches / patches returned per round (`{effort: low}`): mean 63 % over 10 prompts (target ≥ 50 %; below it the extra samples get per-site hints instead of temperature, §4.6).

## 5. Cancellation billing probe

| sample | aborted at | generation id | streamed tool / reasoning chars | usage frame arrived | estimate (in / out tokens, $) | billed (prompt / completion / reasoning tokens, $) | billed / estimate |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 0 | 2007 ms | gen-1790031907-VXnTD9IVu7QVu39N4kJH | 0 / 165 | no | 1042 / 42, $0.000177 | 895 / 44 / 44, $0.000105 | 0.59× |
| 1 | 2008 ms | gen-1790031907-jLIAjnotT7NbJjNG75LZ | 0 / 134 | no | 1042 / 34, $0.000173 | 895 / 37 / 37, $0.000102 | 0.59× |
| 2 | 2009 ms | gen-1790031907-L4VMK8ax74eBFg0DFTQP | 0 / 134 | no | 1042 / 34, $0.000173 | 895 / 37 / 37, $0.000102 | 0.59× |

Over the 3 readable samples: billed $0.000310 vs estimated $0.000524 → 0.59× (§8.1 books cancelled samples at full price until this ratio says otherwise).

## Decisions the probe feeds (§10.2 item 1)

- reasoning flag: `{effort: 'low'}` is the default (finding (a)); 266 reasoning tokens per call on average.
- max_tokens: 1/30 first-round calls stopped at 3,000 (3 %); 1 re-issued at 6,000 of which 1 valid.
- first-round deadline (valid p90): 25.6 s; planning R (valid p50): 2.7 s — §7.3 column R ≈ 6 s applies.
- valid-sample rate at N = 3: 97 % (target ≥ 90 %).


## Addendum (2026-09-21, pre-bench run for the head-to-head)

- This file was regenerated for the head-to-head of `experiments/results/llm-jev-headtohead.md` from the frozen worktree
  `.claude/worktrees/llmjev-clean` (HEAD `626fc40`) with
  `experiments/llm-jev/probes.mts --quixbugs 5 --ladder 5 --samples 3 --variants low --cancel 3 --budget 0.40`
  (30 `propose_fix` calls on 10 real prompts, as §10.2 item 1 asks; 3 cancellations for item 5). The earlier run of the
  same script (committed in `304be21`, 21:33Z, 8 prompts, variants `low,none`) found valid 24/25 (96 %), valid p50 3.2 s /
  p90 48.2 s, anchoring 76/76, diversity 67 %, cancelled billed/estimate 0.90×; this run: valid 30/31 (97 %), valid p50
  2.7 s / p90 25.6 s, all-calls p90 60.2 s / max 171 s, anchoring 58/58, diversity 63 %, cancelled billed/estimate 0.59×.
  The `{enabled: false}` variant was not re-issued: it is HTTP 400 on the served endpoint (`llm-jev-probes-off.md`,
  design §4.13 finding (a)) and nothing in the arm sends it.
- Gates: valid-sample rate 97 % ≥ 90 % (pass); misanchored 0 % ≤ 10 % (pass); diversity 63 % ≥ 50 % (pass); `length`
  stops 1/30 at 3,000, re-issued once at 6,000 and valid. The fat tail is the one thing to carry into the bench reading:
  2 of 30 valid calls took 114 s and 171 s (both `quixbugs/bitcount`, `tool_calls`, served by the same provider pool), so
  the §4.8 20 s / 30 s sample deadlines will cut roughly a tenth of otherwise-valid samples — the head-to-head counts
  those as `timeout` in `generator.jsonl` (19 of 70 llm-jev samples over the 28 tasks).
- Cancelled-sample billing: 0.59× of the §8.1 full-price estimate on 3 samples aborted at 2 s (0.90× on the earlier 2);
  the arm keeps booking cancelled samples at the full estimate (`estimatedUsd` is reported separately in summary.json).
- Spend: $0.0134 of the $0.40 probe budget. Smoke before the probes (`bench/results/llm-jev-smoke`, gcd + kth, llm-jev,
  benchId `20260921-225650-6d489c`): 2/2 pass in 2 steps each, $0.0012, both committed patches `evidence.selection: sieve`
  (gold-identical); the LLM round fired 1/4 staggered samples per goal, both valid (`tool_calls`, 1.8 s and 2.9 s), one
  dropped as `tried` (identical to the argument_swap seed already run) and one distinct candidate that lost the race to
  the seed passer under the §6.2 grace rule.
