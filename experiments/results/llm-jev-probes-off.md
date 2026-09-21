# llm-jev pre-bench probes (docs/LLM-JEV-DESIGN.md §10.2)

Date 2026-09-21T21:21:17.283Z. Model `z-ai/glm-5.3-flash` through OpenRouter; served rate assumed $0.15/$0.5 per M for the estimates. Prompts: `quixbugs/bitcount` (user message 769–769 chars, system 842 chars). 1 samples per round (sample 0 at temperature 0, the rest at 0.8 with per-sample seeds and the class hint schedule). Spent $0.0000 of the $0.4 budget.

## 1. GLM loop probe

| reasoning | calls | valid (parsed, not length) | finish_reason | all p50 / p90 / max | valid p50 / p90 | latency fit | reasoning tokens mean | input p50 / output mean | usage.cost | served provider |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `{enabled: false}` | 1 | 0/0 (n/a) | HTTP 400 1 | n/a / n/a / n/a | n/a / n/a (n=0) | n/a | n/a | n/a | $0.0000 (n/a per call); estimate $0.0000 → billed/estimate n/a× |  |

Per prompt (`{effort: low}`, first round):

| prompt | user chars | valid | samples | diversity (4) | anchoring (2) |
| --- | --- | --- | --- | --- | --- |
| quixbugs/bitcount | 769 | 0/0 |  | 0 patches, 0 distinct (0 %) | 0/0 anchored |

## 2. Anchoring probe

0 hunks from 0 valid samples: 0 anchored, 0 misanchored (n/a; target ≤ 10 %, > 30 % → near_line required and re-probe).

## 4. Diversity

Distinct patches / patches returned per round (`{effort: low}`): n/a.

## 5. Cancellation billing probe

_not run_

## Decisions the probe feeds (§10.2 item 1)

- reasoning flag: `{enabled: false}` is HTTP 400 on this endpoint — `{effort: 'low'}` is the default (finding (a)); no low-variant calls.
- max_tokens: 0/0 first-round calls stopped at 3,000 (n/a); 0 re-issued at 6,000 of which 0 valid.
- first-round deadline (valid p90): n/a; planning R (valid p50): n/a — §7.3 column R ≈ 12 s applies.
- valid-sample rate at N = 1: n/a (target ≥ 90 %).

