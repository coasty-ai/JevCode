# JevCode, Jev-only: a coding agent with no generating LLM

Status: research brief and running log, started 2026-09-20. Everything here is a hypothesis
until a table in `experiments/` says otherwise.

## The constraint

Jev (`typesafe/jev-1.13`) evaluates a JSON state against typed questions and returns calibrated
probabilities. It answers three kinds of question: Noul (yes/no), Choice (one of ≤ 255 named
options), Score (position on a ≤ 10-level rubric). **It does not generate text** (REPORT §1).
Measured: ~170–250 ms per request regardless of question count, 1,000 Nouls in one request,
$0.042 per million input tokens, output free, 128-way concurrency without rate limiting,
calibrated and sharp on clear judgments, noisy (±0.02) in the 0.55–0.80 band, literal.

So a Jev-only coding agent cannot "write" code the way an LLM agent does. It has to **search**:
code (deterministic, cheap) proposes; Jev (fast, calibrated) decides; tests, the compiler and
the linter verify. The question this document answers by experiment is which decomposition of
"write a fix" into proposals-and-decisions works, and how far it reaches.

## Why this can work at all

1. **Program repair was search before it was generation.** GenProg, Prophet, TBar, SimFix and
   CapGen fixed real bugs by enumerating candidate edits from mutation operators, fix
   templates and "donor" code already present in the repository (the plastic-surgery
   hypothesis: most fix ingredients exist elsewhere in the same project). Their bottleneck was
   *ranking*: thousands of candidates, a handful correct, tests too slow to try them all.
   Prophet learned a ranker from past fixes and doubled the success rate. Jev is a fast,
   calibrated, general ranker that reads the failing test and the code.
2. **Jev is a strong selector.** REPORT §9–§11: 12-way Choice on topics 100 %; rerank of 218
   candidates top-1 5 % → 18 % with one Noul per pair; 255 informative options answered at
   confidence 1.0; entailment 0.98 accuracy. Selection over a few hundred concrete candidate
   edits is squarely what it is good at.
3. **Jev is fast and cheap enough to be the inner loop.** A beam search that asks Jev to rank
   200 candidates costs one request (~250 ms, ~$0.0003). Ten rounds of localise → rank → verify
   is seconds and cents. Tests, not Jev, are the ground truth; Jev's job is to make the number
   of test runs small.
4. **Generation can be reduced to a sequence of Choices.** A fix line can be built as a path
   through a grammar: statement kind → expression shape → identifiers from scope → literals
   from the test. Each decision is a Choice over a code-computed option set with the code, the
   failing test and the partial line in the state. Whether Jev's judgment survives 10–30 such
   decisions in a row is an empirical question, measured below.

## Candidate sources (code proposes)

| Source | What it enumerates | Cost | Where it comes from |
| --- | --- | --- | --- |
| Mutation operators | operator swaps (`<`↔`<=`, `+`↔`-`, `and`↔`or`, `==`↔`!=`), off-by-one (`±1`), index flips, argument swaps, negations, constant substitutions from literals in the test | thousands/line | GenProg, TBar |
| Fix templates | null/None guards, missing return, missing import, wrong attribute (Choice over attributes of the receiver), wrong call target (Choice over functions in scope), missing `else`, boundary condition | tens/site | TBar, Refactory |
| Donor code | lines/statements elsewhere in the repo that reference the same identifiers, adapted by identifier substitution (Choice over in-scope names) | hundreds/site | plastic-surgery hypothesis, SimFix |
| Test-derived values | expected literals, expected types, expected exceptions and messages parsed from the failing assertion | few | Agentless-style reproduction, program synthesis by example |
| Grammar-guided synthesis | new lines built by Jev Choices over grammar productions and in-scope identifiers, beam-searched, verified by tests | slow (10–30 requests per line) | this project |
| Repository history | past commits that touched the same function or symbol (`git log -S`), replayed as templates | tens | history-based repair |

## Decisions Jev makes (Jev decides)

- **Understanding**: Choice over the kind of change (fix a wrong value / add a guard / add a
  branch / change a call / add a function / change a signature / configuration / unknown),
  Nouls per file and per symbol named or implied by the task text, Choice over which failing
  test to attack first.
- **Localisation**: Nouls over candidate files (existing context stage); Choice/Nouls over
  functions; Choice over lines of the located function, combined in code with spectrum-based
  fault localisation (Ochiai over coverage of failing and passing tests) when tests exist.
- **Ranking**: Choice over ≤ 255 concrete candidate edits (with the buggy line, the failing
  test, expected vs actual in the state), or Nouls per candidate when "none of these" is
  likely; beam of k kept for verification.
- **Progress**: after a candidate is applied and tests run, Nouls "did the failing test pass",
  "did a previously passing test break", "is the output closer to the expectation"; Choice
  over the next move (keep and continue with the next failing test, revert and widen
  localisation, try the next candidate source, stop).
- **Everything already in the JevCode loop**: intent, context, risk, judge, completion, replan.

## Difficulty ladder (measured in this order)

1. QuixBugs Python (40 programs, one-line bugs, tests as JSON): localisation, selection,
   end-to-end repair rate, cost, time. The classic search-based-repair yardstick.
2. `examples/demo-py` and hand-made multi-hunk tasks: two coordinated one-line fixes, a
   missing guard plus a test.
3. HumanEvalPack / HumanEval-fix style functions where the fix needs a new line.
4. SWE-bench Verified subset (the 30 already checked in) with the `jev-only` condition beside
   `jev-on` and `jev-off`: honest numbers, expected low.

## Success criteria for "surprisingly well"

- QuixBugs: ≥ 60 % repaired end to end with tests as the only oracle and Jev the only model,
  under $0.05 and 2 minutes per program (search-based systems without a learned ranker sit
  around 25–40 % here; the delta is the value of Jev as the ranker).
- Multi-hunk ladder tasks: solved by the outer loop decomposing per failing test.
- SWE-bench subset: any instance solved by a system with no generating model is a result;
  report it with the evidence and the failure taxonomy.

## Non-negotiables

- No generating LLM anywhere in the `jev-only` mode: the generator Provider is a
  `NullProvider` that throws if called, and the bench asserts zero generator tokens.
- Tests are the oracle; Jev never marks a fix correct on its own.
- Every candidate source is code with a unit test; every Jev question follows the REPORT rules
  (escape options, criteria, backticked paths, no counting).
- Every experiment writes a table under `experiments/results/` with the exact prompt shapes,
  n, accuracy, cost and latency, so the design is chosen by measurement.

## Log

- 2026-09-20: anchor probe on QuixBugs (localisation Choice over lines; selection Choice over
  mutation candidates) — see `experiments/results/anchor-probe.md`.
- 2026-09-20: **prototype baseline** (`experiments/results/prototype-baseline.md`, scripts in
  `experiments/prototype/`): localise (Choice over lines with tests and actual output) →
  first-order mutation candidates (15 operator families, cap 200) → one Choice per line → verify
  top-5 with the QuixBugs runner → adopt strict pass-count improvements, 3 rounds. **32/40
  repaired** (31 correct by inspection; 1 overfits), $0.035 total Jev, 62 s wall for all 40,
  mean 5.3 Jev requests and 10 test runs per program. Coverage ceiling 35/40 (4 insertion bugs
  and one two-edit bug are unreachable by single-line replacement). Failures: 4 coverage, 2
  localisation (true line rank 6 at p 0.02–0.03), 2 greedy-progress traps. Two runs of the same
  code agree on 30 repairs and 34 in at least one, so the flips sit in Jev's 0.03–0.30 band.
- 2026-09-20: measurement files landed (`experiments/results/*.md`, each with a verification
  section): localisation 28/40 top-1 with actual output, SWE-bench file localisation 24/30 top-1
  over ~219 paths and gold #1 on 23/30 over every repo file with plain Nouls; selection top-3
  37/40 even at 254 candidates, two-stage Nouls→Choice 33/40 top-1, fix-absent detector
  P(escape)−p_max ≥ 0.10 (AUROC 0.92); first-order mutations reach 38/40 gold fixes; donor line
  selection 35/36, identifier hole filling 13/13; token beam W=3 with a grammar filter rebuilds
  20/40 fix lines at $0.0037 per line, portfolio of routes 27–28/40; progress Nouls read
  code-computed counts perfectly but add nothing over code when counts exist; question-design:
  drop the unchanged line from options, include expected AND actual, thresholds 0.7 Choice /
  0.5 Noul.
