# llm-jev pre-bench probes (docs/LLM-JEV-DESIGN.md §10.2)

Date 2026-09-21T21:33:32.066Z. Model `z-ai/glm-5.3-flash` through OpenRouter; served rate assumed $0.15/$0.5 per M for the estimates. Prompts: `quixbugs/bitcount`, `quixbugs/bucketsort`, `quixbugs/find_first_in_sorted`, `quixbugs/find_in_sorted`, `quixbugs/flatten`, `ladder/account`, `ladder/calendar_utils`, `ladder/crossfile` (user message 769–7121 chars, system 842 chars). 3 samples per round (sample 0 at temperature 0, the rest at 0.8 with per-sample seeds and the class hint schedule). Spent $0.0394 of the $0.4 budget.

## 1. GLM loop probe

| reasoning | calls | valid (parsed, not length) | finish_reason | all p50 / p90 / max | valid p50 / p90 | latency fit | reasoning tokens mean | input p50 / output mean | usage.cost | served provider |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `{effort: low}` | 25 | 24/25 (96 %); 1 re-issued at 2× | tool_calls 24, length 1 | 3.2 s / 62.8 s / 149.7 s | 3.2 s / 48.2 s (n=24) | 0.3 s + 21.8 ms/token (n=24) | 332 | 1168 / 565 | $0.0109 ($0.00044 per call); estimate $0.0128 → billed/estimate 0.85× | Wafer, CoreWeave, Together |
| none | 31 | 20/31 (65 %); 7 re-issued at 2× | tool_calls 22, length 9 | 15.5 s / 35.6 s / 45.2 s | 15.5 s / 35.6 s (n=20) | 9.2 s + 3.6 ms/token (n=20) | 1285 | 1226 / 1417 | $0.0281 ($0.00091 per call); estimate $0.0296 → billed/estimate 0.95× | Wafer, CoreWeave, Together |

Per prompt (`{effort: low}`, first round):

| prompt | user chars | valid | samples | diversity (4) | anchoring (2) |
| --- | --- | --- | --- | --- | --- |
| quixbugs/bitcount | 769 | 3/3 | tool_calls 48.2s, tool_calls 62.8s, tool_calls 3.0s | 3 patches, 2 distinct (67 %) | 3/3 anchored |
| quixbugs/bucketsort | 940 | 3/3 | tool_calls 30.1s, tool_calls 2.3s, tool_calls 1.7s | 3 patches, 1 distinct (33 %) | 3/3 anchored |
| quixbugs/find_first_in_sorted | 1057 | 2/3 | length 107.0s, tool_calls 3.2s, tool_calls 15.4s | 2 patches, 2 distinct (100 %) | 4/4 anchored |
| quixbugs/find_in_sorted | 927 | 3/3 | tool_calls 1.7s, tool_calls 1.7s, tool_calls 2.9s | 3 patches, 1 distinct (33 %) | 3/3 anchored |
| quixbugs/flatten | 923 | 3/3 | tool_calls 8.3s, tool_calls 3.8s, tool_calls 1.4s | 3 patches, 1 distinct (33 %) | 3/3 anchored |
| ladder/account | 3635 | 3/3 | tool_calls 4.1s, tool_calls 2.2s, tool_calls 4.2s | 4 patches, 4 distinct (100 %) | 12/12 anchored |
| ladder/calendar_utils | 3880 | 3/3 | tool_calls 1.8s, tool_calls 2.4s, tool_calls 3.2s | 3 patches, 2 distinct (67 %) | 9/9 anchored |
| ladder/crossfile | 7121 | 3/3 | tool_calls 4.5s, tool_calls 2.0s, tool_calls 3.7s | 5 patches, 5 distinct (100 %) | 12/12 anchored |

## 2. Anchoring probe

76 hunks from 44 valid samples: 76 anchored, 0 misanchored (0 %; target ≤ 10 %, > 30 % → near_line required and re-probe).

## 4. Diversity

Distinct patches / patches returned per round (`{effort: low}`): mean 67 % over 8 prompts (target ≥ 50 %; below it the extra samples get per-site hints instead of temperature, §4.6).

## 5. Cancellation billing probe

| sample | aborted at | generation id | streamed tool / reasoning chars | usage frame arrived | estimate (in / out tokens, $) | billed (prompt / completion / reasoning tokens, $) | billed / estimate |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 0 | 1898 ms | none (aborted before the headers) | 0 / 0 | no | 1042 / 0, $0.000156 | not readable | n/a |
| 1 | 2003 ms | gen-1790026349-dsxPVDV9FJXx0LQIxBgn | 131 / 115 | no | 1042 / 62, $0.000187 | 895 / 65 / 29, $0.000167 | 0.89× |
| 2 | 2003 ms | gen-1790026349-5nGquCrm3zUboCX6c5HK | 308 / 30 | no | 1042 / 85, $0.000199 | 895 / 96 / 8, $0.000182 | 0.92× |

Over the 2 readable samples: billed $0.000349 vs estimated $0.000386 → 0.90× (§8.1 books cancelled samples at full price until this ratio says otherwise).

## Decisions the probe feeds (§10.2 item 1)

- reasoning flag: `{effort: 'low'}` is the default (finding (a)); 332 reasoning tokens per call on average.
- max_tokens: 1/24 first-round calls stopped at 3,000 (4 %); 1 re-issued at 6,000 of which 1 valid.
- first-round deadline (valid p90): 48.2 s; planning R (valid p50): 3.2 s — §7.3 column R ≈ 6 s applies.
- valid-sample rate at N = 3: 96 % (target ≥ 90 %).

