# experiments/prototype: Jev-only repair loop on QuixBugs

A search-based program-repair loop with no generating LLM: code proposes candidate lines
(mutation operators), Jev (`typesafe/jev-1.13-20260917`) ranks lines and candidates, tests
decide. Results: `experiments/results/prototype-baseline.md` (+ `prototype-baseline.jsonl`, one row per program, run 3; `prototype-baseline-run1.jsonl` is an earlier run of the same code, kept for the run-to-run comparison).

## Prerequisites

- `npm install` at the repo root (the scripts import the project's `src/jev/client.ts`; nothing
  under `src/` or `docs/` is modified).
- `python3` 3.9+ (stdlib only). The programs, tests and runner are the checked-in copy of
  QuixBugs at a pinned commit in `bench/data/quixbugs/` (see its README); `QUIXBUGS_ROOT` overrides
  the location. No pytest, Docker or network is needed for the test side.
- `.env` at the repo root with `OPENROUTER_API_KEY` (never printed by any script here).

All commands run from the repo root. `env -u ANTHROPIC_API_KEY` is a belt-and-braces guarantee that
no generating model is reachable while the loop runs.

## Files

| File | Role |
| --- | --- |
| `quixbugs.mts` | loads programs and tests from `bench/data/quixbugs`, computes the ground-truth fix line by aligning buggy and correct code (comments stripped; measurement only, never shown to Jev). `tsx experiments/prototype/quixbugs.mts` prints the truth table (36 single-line replacements, 4 insertions). |
| `mutations.mts` | mutation-operator candidate library: tokenizer, in-scope identifier harvesting, 15 generic operator families (`buildContext`, `enumerateCandidates`, `filterSyntactic`). No program-specific rules. |
| `coverage.mts` | is the reference fix in the candidate set of the true line? Per program and totals, capped and uncapped; no Jev. |
| `mutations.test.mts` | operator unit checks (plain `node:assert`). |
| `verify.mts` | one test run of a candidate program = one call of `bench/data/quixbugs/run_tests.py` (per-test 2 s subprocess timeouts, QuixBugs' leniency: generators listed, `hanoi` tuples, `sqrt` within epsilon; upstream `slow` skips; module tests for the 9 graph programs run in order with SIGALRM timeouts). |
| `verify-selftest.mts` | correct programs must pass everything, buggy ones must fail something, broken candidates must be reported as runner errors. |
| `jev.mts` / `jev-smoke.mts` | Jev wrapper with a spend cap and a request meter; one-request smoke test. |
| `loop.mts` | the repair loop (localise → enumerate → rank → verify, progress rounds, budgets). |
| `report.mts` | renders the `.jsonl` into the generated section of `prototype-baseline.md` (hand-written text outside the markers is preserved). |

## Rerun

```sh
# no Jev, no network
node node_modules/.bin/tsx experiments/prototype/quixbugs.mts          # truth table
node node_modules/.bin/tsx experiments/prototype/coverage.mts          # candidate coverage (≈2 s)
node node_modules/.bin/tsx experiments/prototype/verify-selftest.mts   # runner sanity (≈8 s)
node node_modules/.bin/tsx experiments/prototype/mutations.test.mts    # operator unit checks

# one cheap Jev request (~$0.00002)
env -u ANTHROPIC_API_KEY node --env-file=.env node_modules/.bin/tsx experiments/prototype/jev-smoke.mts

# the full baseline (40 programs; a few cents of Jev; minutes of wall time with --concurrency 3)
env -u ANTHROPIC_API_KEY node --env-file=.env node_modules/.bin/tsx experiments/prototype/loop.mts --concurrency 3 --verbose
#   --only gcd,sieve   subset       --limit 5   first n       --resume   skip programs already in the jsonl
#   --cap 1.4          Jev spend cap in USD for the run (the script stops at the cap)
#   --out <path>       jsonl location (default experiments/results/prototype-baseline.jsonl)
node node_modules/.bin/tsx experiments/prototype/report.mts             # regenerate the tables in the .md
```

Budgets per program (`DEFAULT_CONFIG` in `loop.mts`): 40 test runs, 30 Jev requests, 180 s wall,
k = 5 verifications before widening from the top-3 to the top-5 lines, 200 candidates per line,
3 progress rounds. Progress ("strictly more tests pass") is computed in code, never asked of Jev.

## What Jev sees

- Localisation (`stage: context`, one Choice): `{ task, program: { L1: ..., L2: ... }, tests: [3 tests,
  the failing one always included], actual_output: { test, input, expected, actual } }`; options
  `line_N` = the text of each code line, plus `none_of_these` ("the fix needs a new line").
  For the graph programs `tests` are the sources of three test functions plus the module setup
  code and the `Node` class; `actual_output` is the runner's failure text.
- Ranking (`stage: risk`, one Choice per line, lines in parallel): the same state plus
  `buggy_line: { id, text }` and `candidates: { candidate_001: <line>, ... }`; options are the
  candidate keys plus `none_of_these`.
- Nothing else. Pass counts, progress and budgets are computed in code.
