# The four modes

A mode decides **who proposes the code** and **who decides what happens to it**. There are
four. They share one engine and one set of records, so a result from one is comparable with a
result from another.

## At a glance

| Mode | Badge | Who writes the code | Who decides | Default run cap |
| --- | --- | --- | --- | --- |
| `llm-jev` | `llm+jev · verified` | the code model, inside the search | tests verify, Jev arbitrates | $10.00 |
| `jev-on` | `jev+llm` | the code model, one action per step | Jev, at every stage | $10.00 |
| `jev-only` | `jev-only` | nobody — code enumerates candidates | tests verify, Jev ranks | $1.00 |
| `jev-off` | `llm-only` | the code model alone | nobody | $10.00 |

`llm-jev` is the default. The session cap is five times the run cap in every mode, so $50.00
for three of them and $5.00 for `jev-only`.

## How to switch

| Where | How |
| --- | --- |
| launch | `jevcode --mode jev-only` |
| inside a session | `/mode jev-only` — takes effect on the **next** run; the badge reads `jev-only · next run` until it does |
| environment | `JEVCODE_MODE=jev-only` |
| persistently | `jevcode config set mode jev-only` |

The precedence is the usual one: flag, then the environment, then `./.env`, then the config
file, then the default. One constant in `src/config/defaults.ts` names the default, and every
message that mentions it reads that constant, so the two can never disagree.

## What each mode is for

### `llm-jev` — the default

The code model writes candidate patches **inside** the search. Tests verify them, and Jev only
arbitrates between candidates that already pass.

There is no intent stage and no context stage: the step starts at propose. Risk asks only the
harm dimensions — `destructive` and `irreversible` — and records the two alignment dimensions
at level 0 without letting them gate. Judge is code: the parsed failing counts decide, and
Jev's judge answers are recorded rather than consulted. Completion is a code fact about the
harness's own green run, not a probability.

If the search does not cover a workspace — not Python, no tests, feature work rather than a
bug — that step falls back to the ordinary "the code model writes one action" path.

### `jev-on` — Jev decides every step

The full pipeline: replan, intent, context, propose, risk, judge, complete. The code model
writes one action per step and Jev is asked at every stage. This is the mode the recorded
transcript in [Your first run](first-run.md) shows.

### `jev-only` — no generating model at all

The propose stage is a synthesizer instead of a model: code enumerates candidate fixes, the
tests are the oracle, and Jev ranks and arbitrates. See
[The synthesizer](../concepts/the-synthesizer.md).

The claim that this makes **zero** generating-model calls is a property of every record, not a
slogan. In one recorded 40-program run, all 40 records carry `generatorCalls: 0`, all of
`generatorTokensPerStep` zero, and `cost.generator` exactly 0.

Its run cap defaults to $1.00 rather than $10.00 because there is no code model to pay for.

### `jev-off` — the control arm

The code model alone. No decision, no intent, no context, no risk, no judge and no replan event
ever fires. It exists so that every claim about the other three has something to be measured
against. `src/loop/generator-only.ts` is a thin factory that pins the mode; the engine is the
same one, taking the branch where the decision model is absent.

## The dispatch, as a picture

```mermaid
flowchart TD
  MODE{"EngineMode"}
  MODE -->|"jev-on"| ON1
  MODE -->|"llm-jev — the default"| LJ1
  MODE -->|"jev-only"| JO1
  MODE -->|"jev-off"| OF1

  subgraph sg_on["jev-on"]
    ON1["replan, intent and context all ask Jev"]
    ON2["propose — proposeWithContext: the code model writes one action"]
    ON3["risk — runRiskStage: four Scores plus matches_intent"]
    ON4["judge and complete — runJudgeStage"]
    ON1 --> ON2 --> ON3 --> ON4
  end
  subgraph sg_lj["llm-jev"]
    LJ1["no intent and no context stage — the step starts at propose"]
    LJ2["propose — runSynthStage: the code model writes candidates inside the search"]
    LJ3["risk — runHarmOnlyRiskStage: harm dimensions only"]
    LJ4["judge — runCodeJudgeStage: the parsed failing counts decide"]
    LJ5["complete — isCompleteByFact, a code fact"]
    LJ1 --> LJ2 --> LJ3 --> LJ4 --> LJ5
  end
  subgraph sg_jo["jev-only"]
    JO1["the jev-on pipeline, with propose swapped for the synthesizer"]
    JO2["propose — runSynthStage: Ledger plus Sieve, zero generator calls"]
    JO3["tests are the oracle; Jev ranks and arbitrates"]
    JO1 --> JO2 --> JO3
  end
  subgraph sg_of["jev-off"]
    OF1["the same engine, with every Jev consumer skipped"]
    OF2["no decision, intent, context, risk, judge or replan event fires"]
    OF1 --> OF2
  end

  ON4 --> COMMIT["commit, checkpoint, steps.jsonl"]
  LJ5 --> COMMIT
  JO3 --> COMMIT
  OF2 --> COMMIT
```

## What is measured

Two head-to-heads, both from the same frozen build, both recorded in
[`../LLM-JEV.md`](../LLM-JEV.md) under the dated 2026-09-22 entries. Read them with their
caveats, which are given below the table.

| Slice | `llm-jev` | control | Notes |
| --- | --- | --- | --- |
| same-build, 28 tasks | **28/28**, Wilson [88 %, 100 %] | plain `jev-off` **21/28**, [57 %, 87 %] | discordance b = 7 / c = 0, exact sign p = 0.0078 |
| — median wall, pooled | 63.0 s | 246.3 s | one-sided censoring: 8 of 28 control runs hit the wall cap, 0 of 28 candidate runs did |
| — median wall, the 21 both solved | 39.5 s | 175.3 s | per-task ratio median 0.291; the candidate was slower on 1 of 21 |
| — cost | $0.1441 | $0.5875 | see the cost-basis caveat |
| out of sample, 22 tasks | **13/22**, [39 %, 77 %] | tuned `jev-off` **12/22**, [35 %, 73 %] | discordance b = 2 / c = 1, p = 0.500 |
| — median wall, pooled | 190.7 s | 137.7 s | **1.385× against** the candidate |
| — cost | $0.7918 | $0.2959 | **2.68×** the control |

**Caveats that travel with those numbers.** One run per arm. The in-sample 28 include the tasks
some thresholds were tuned on, so that row is in-sample and does not generalise as a capability
claim. The out-of-sample 22 were chosen by fixed rules to exclude every tuned name. The
SWE-bench evaluator is a local-virtualenv replica, not the official container. The warm
verification plane was off for every number. And the cost basis is not symmetric: **78 % of
`llm-jev`'s dollars are an estimate or a rate card** (88.4 % on the out-of-sample slice), while
the baseline's are 100 % provider-reported. Any dollar comparison has to carry that sentence.

The honest reading: inside the one-line-bug regime the mode transfers — same pass rate, about a
third of the wall, about a third of the dollars, and zero overfits on ten programs it was never
fitted to. Outside it, the extra decision traffic bought one extra ladder task and no SWE
instance for roughly three times the time and money.

`jev-only` and `jev-on` have their own measurement logs: [`../JEV-ONLY.md`](../JEV-ONLY.md) and
the rows in [`../STATUS.md`](../STATUS.md).

## Depth

- [`../DESIGN.md`](../DESIGN.md) §21 — `jev-only`, normative
- [`../DESIGN.md`](../DESIGN.md) §22 — `llm-jev`, normative
- [`../JEV-ONLY.md`](../JEV-ONLY.md) — the dated measurement log for `jev-only`
- [`../LLM-JEV-DESIGN.md`](../LLM-JEV-DESIGN.md) §1 — why `llm-jev` exists

## Next

- [What Jev is](../concepts/what-is-jev.md)
- [The synthesizer](../concepts/the-synthesizer.md)
- [Verification and the oracle](../concepts/verification.md)
