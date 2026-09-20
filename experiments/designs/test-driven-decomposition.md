# Test-driven decomposition: a long-horizon Jev-only synthesis engine

Design document, 2026-09-20. Author role: architect. Live Jev spend for this document: **$0.00**; every
number below is quoted from a verified results file under `experiments/results/` (file and figure named
inline) or from `bench/data/*/README.md`. Where a design element has **no** measurement behind it, the
text says so and §8 names the experiment that would supply one.

The slot being filled is `Synthesizer.synthesize(ctx) → Proposal` (`src/core/types.ts`, `SynthesisContext`
gives `workspace`, `sandbox`, `ask`/`decider`, `contextFiles`, `plan`, `window`, `signal`, `limits`,
`directive`). The outer loop (DESIGN.md §6: replan → intent → context → propose → risk → execute →
judge+complete) is unchanged; this engine is the propose stage in `jev-only` mode and nothing else.

## 0. The idea in one paragraph

A task is not "write a fix"; it is a **queue of failing behaviours**, each caught by one or more failing
tests, each fixable by a small local edit that must not break what already passes. The engine keeps a
persistent ledger of sub-goals (one per cluster of failing tests that share a suspected site), lets Jev
choose which sub-goal to attack next, runs a **small, bounded search** for that sub-goal (code
enumerates candidate edits at the localised sites; Jev ranks them; the tests, run on shadow copies in the
sandbox, decide), and commits a candidate only when it makes the attacked tests pass and breaks nothing.
Progress is measured in code from test counts, never asked of Jev. A committed candidate is a `patch`
Proposal; the next step is a `run` of the full suite so the outer loop's own record (and its completion
Noul) sees the oracle. A sub-goal whose search is exhausted is **parked**, not retried, and the queue moves
on; a regression is reverted, never kept; a partial improvement is held as a second base rather than
adopted blindly. "Done" is: every test passes on the committed workspace, tests unchanged, and a cheap
Jev overfit guard did not object.

Why this decomposition and not "one big search": the coverage study says 19 of 30 SWE-bench Verified gold
patches have 2+ code hunks and a fix "is only reachable if every hunk is" (`coverage-study.md`, design
point 5), and the ladder README shows that in the five multi-bug tasks "every hunk on its own fixes at
least one test and none suffices" (`bench/data/ladder/README.md`, verification matrix). The prototype's two
`ranking_missed` failures and one run-1 failure were all the greedy-progress trap of adopting a pass-count
improvement as the new base (`prototype-baseline.md`, "Progress rounds"). The unit of work that the
measurements support is therefore *one failing behaviour at a time, verified, revertible, with the
partial-improvement path kept as an alternative rather than a commitment.*

## 1. The algorithm

### 1.1 Persistent state (owned by the synthesizer, survives steps; rebuilt on resume)

```ts
interface SearchMemory {                       // in-memory per runId; the durable copy is plan.remaining + the workspace
  baseline: TestRunSummary | null;             // full-suite run on the committed workspace (code)
  goals: Goal[];                               // sub-goal ledger, see below
  triedDiffs: Set<string>;                     // sha of every candidate diff ever applied to a shadow (never re-tested)
  committed: AppliedCandidate[];               // accepted candidates in commit order (for revert directives)
  bases: Base[];                               // ≤ 2 bases: the committed workspace and at most one "improved but not green" alternative
  localizeCache: Map<goalKey, LocalizeResult>; // sites per goal; invalidated when a file in it changes
  stepBudget: { jevRequests: number; testRuns: number; startedMs: number };
}
interface Goal {
  id: string;                                  // e.g. "g3"
  tests: string[];                             // failing test ids in this cluster
  failures: FailureView[];                     // expected / actual per test (code-computed, bounded)
  suspectedFiles: string[];                    // from traceback frames + SBFL; refined by localisation
  status: 'open' | 'active' | 'parked' | 'fixed';
  attempts: number;                            // searches run for this goal
  exhausted: Set<CandidateSourceName>;         // sources fully enumerated + ranked + tested at every site of this goal
  parkedReason?: string;                       // "fix not in any source at 6 sites", "coupled edit suspected", ...
}
interface Base { files: Map<path, SourceFile>; summary: TestRunSummary; origin: 'committed' | 'improved'; fromGoal: string }
```

Durability rule: `plan.remaining` carries one item per open/parked goal in the fixed form
`fix <test_id>[, +N more] in <path>` and `plan.done` one per fixed goal (accepted by the engine's `done_<j>`
Noul on the `run` step that shows the tests passing, DESIGN §6 Plan rule a). On `--resume` the memory is
empty; the first step re-runs the baseline, re-derives goals from the failing tests and re-attaches them to
the plan items by test id. Nothing else needs to be durable: tried diffs that are lost are re-tested at the
cost of test runs, never of a wrong commit.

### 1.2 One step (`synthesize(ctx)`), top level

```
synthesize(ctx):
  mem = memory(ctx.runId) ; mem.stepBudget = fresh(ctx.limits)
  if ctx.directive is set:                     # the outer replan stage tripped (DESIGN §6 Loop detection)
      return handleDirective(ctx, mem)         # §4.4: revert_changes → reverse patch; gather_context → read; change_approach → widen
  if lastStepWas(ctx.window, 'patch') and outcome executed:
      return proposeRun(ctx, fullSuite)        # make workspace.lastTestRun / testsCurrent true for the engine (§4.2)
  if mem.baseline is null or workspaceChangedSince(mem.baseline):
      mem.baseline = runFullSuite(ctx)          # code; 1 test run; shadow of the committed workspace
      mem.goals    = clusterFailures(mem.baseline)     # §1.3, code-only grouping, Jev optional
  if mem.baseline.allPass:
      if not overfitGuardPassed(mem): mem.notes.push(...)   # Q11, advisory
      return proposeDone(ctx, mem)             # §4.5
  goal = pickGoal(ctx, mem)                    # Q1 attack_first (Jev) + code tiebreak, over open goals only
  if goal is null:                             # everything parked
      return proposeDoneOrReport(ctx, mem)     # §4.5 honest partial summary; engine's replan/impossible ends the run
  result = searchSubGoal(ctx, mem, goal)       # §1.4
  switch result.kind:
    'commit':   mem.committed.push(result.applied); goal.status = 'fixed' (or 'open' if tests remain in the cluster)
                return proposePatch(ctx, result.applied, goal)      # Proposal.action = { kind:'patch', diff }
    'parked':   goal.status = 'parked'; goal.parkedReason = result.reason
                return synthesize(ctx)          # at most once more this step: pick the next open goal (bounded by stepBudget)
    'budget':   return proposeRun(ctx, goalSubset(goal))            # cheap step that records evidence; search resumes next step
```

One step = one sub-goal attempt (or the bookkeeping `run` after a commit). The recursion on `parked` is
bounded: a second `parked` in the same step returns `proposeRun` so the step always yields a Proposal
within `stepBudget`.

### 1.3 Sub-goal construction (code) and selection (Jev)

`clusterFailures(summary)`: group failing tests by **(file, function)** of the deepest non-test frame in
their traceback when the runner gives one (pytest), else by the top SBFL function when coverage was
collected (`src/synth/sbfl`), else one goal per failing test. Two tests are merged when their anchors are
within 3 lines. This is code only. An optional Jev Noul `same_cause_<t>` ("Do `failing_tests.<a>` and
`failing_tests.<b>` fail for the same underlying defect?") is **not measured** and is off by default (§8,
risk 3).

**Q1 `attack_first`** (Choice, one request, state `{ task, failing_tests: { <test_id>: { input|call, expected,
actual, status } } }`, options = up to 10 open goals keyed by their first test id with the failure text as
description, plus `none_of_these`): neutral wording measured in `probe-progress-judgment.md` Part 3,
"Which entry of `failing_tests` should the repair attack first?": picks the simplest input 16/34 strict
(random 8/34), MRR 0.67, escape mass 0.10; its neutral picks "tend to be the smallest *informative* case".
Consumption: take the argmax if its probability beats the runner-up by > 0.02 (the tie margin in
`src/synth/verify/questions.ts`), else the code tiebreak: fewest tests in the goal, then shortest serialised
input, then lowest attempts. When one goal is open, no request. The escape argmax (only `wrap` in the probe,
950-char inputs) falls to the tiebreak.

### 1.4 The small search for one sub-goal

```
searchSubGoal(ctx, mem, goal):
  sites = mem.localizeCache[goal] ?? localize(ctx, goal)          # §1.5: ≤ 6 line sites + ≤ 6 insert gaps, ranked
  cls   = editClass(ctx, goal, sites[0])                           # Q6: soft prior over sources, never a gate
  for source in orderSources(cls, goal.exhausted):                 # §2 order
     for site in sites (in rank order, ≤ 6):
        cands = source.enumerate(site, opts) \ mem.triedDiffs \ {unchanged line}      # code, compile-filtered
        if cands.empty: continue
        ranked = rank(ctx, cands, site, goal)                      # Q7: Choice / hybrid / two-stage Nouls (src/synth/rank)
        if ranked.fixProbablyAbsent and site is not the last site: continue   # code-computed detector, §1.6
        k = ranked.ranked.filter(p ≥ 0.05).slice(0, K_VERIFY)      # K_VERIFY = 3 (5 when site probability ≥ 0.9)
        results = verifyParallel(ctx, mem, k, goal)                # §3: goal-subset tests on ≤ 4 shadow lanes
        for (cand, prog) in results ordered by ranked probability:
           move = route(prog, searchState)                         # code, src/synth/verify/progress.ts
           if move == 'accept_and_stop' or (move == 'accept_and_continue' and prog.newlyPassing ⊇ goal.tests):
               full = runFullSuite(shadow(cand))                   # regression check on the whole suite, 1 run
               if full.regressed: mem.triedDiffs.add(cand); continue           # REGRESSION_RULE: never keep a break
               return { kind:'commit', applied: cand }
           if move == 'accept_and_continue':                       # partial: some goal tests pass, none break
               holdAsBase(mem, cand, prog)                         # §1.7 beam of bases, no commit yet
        if mem.stepBudget.exhausted(): return { kind:'budget' }
     goal.exhausted.add(source.name)
  if mem.bases has an 'improved' base for this goal:              # nothing green, but a strict improvement exists
     return { kind:'commit', applied: mem.bases.improved.candidate }   # commit the best partial (its full-suite run had no regressions)
  return { kind:'parked', reason: describe(goal.exhausted, sites) }
```

Every branch is total: a source either produces a commit, is exhausted at every site, or hits the step
budget. `triedDiffs` guarantees no candidate is tested twice across steps, which is also what keeps the
outer loop detector's `patch:` signature from ever repeating (§4.3).

### 1.5 Localisation for one sub-goal (existing `src/synth/localize`, restricted to the goal)

The localizer already implements the measured pipeline; this design fixes **what goes in the state**: only
the goal's failing tests, each with the buggy program's actual output, plus the traceback when present.

| Id | Type | Options (code-built) | Wording (measured) | Consumed as | Measurement |
| --- | --- | --- | --- | --- | --- |
| Q2 `fix_file_<path>` | Noul per file, criteria once in state, ≤ 250 per request | every workspace `.py` path (non-test), batched | "Must the file `<path>` (listed in `files`) be modified to fix `issue`? Apply `criteria`." | **by rank, never threshold**: top-5 beam | `probe-swebench-understanding.md` Q6: gold #1 23/30, ≤5 28/30, ≤10 30/30, $0.0011/instance, ≤4 requests; at 0.5 precision is 0.54 so thresholds are not used |
| Q3 `fix_file_confirm_<path>` | Noul per beam file with `top_level_symbols` outline | the top-5 files | Q3 wording of the same file: "Must the file `files["<path>"]` be modified to fix `issue`? Answer yes only if the code change that fixes the issue lands in this file." | re-rank the beam | Q3: gold ranked first 31/33 with outlines vs 28/33 paths only; separated 3 sibling-name confusions |
| Q4 `fix_function` | Choice over defs of one file (+ `module_level_code_outside_any_function`, escape) | signature lines, nested classes flattened | "`file` is the source file that must be edited to fix `issue`. Which entry of `file.functions` must be modified …" | global top-5 functions across the file beam | Q2: top-5 35/37, top-1 19/37; median 41 options; $0.0001 |
| Q5 `buggy_line` | Choice over code lines of one function (escape) | keys `line_<n>`, description = line text, disambiguated with the enclosing def when duplicated | variant D: "Which line of `program` contains the bug? Pick the single line that must change so that the function is correct. Choose `none_of_these` only if no listed line is faulty." with `failing_test_run` (input, expected, **actual**) in the state | top-3 anchors per function, **unioned with SBFL top-3** when coverage exists; each anchor becomes a `replace` site and two `insert` gaps (before/after) | `probe-localization.md` D: top-1 28/40, top-3 36/40; D∪C top-3 covers 38/40; actual output is the only wording that moved top-1 (+5 every run); `lit-search-based-repair.md` §6: Ochiai top-5 34/38 on QuixBugs. Q4 (SWE): top-5 within ±3 94 % of functions, 97 % of primary functions |
| Q5b `insert_after` | Choice over gaps `after_l<i>` (escape) | every line of the located function | "Where in `program` must the missing statement be inserted so that all `tests` pass?" | adds ≤ 3 insert sites, ranked after the replace sites unless Q6 says `insert_new_line` | `probe-donor-and-templates.md` §4: 4/4 with the statement given, 2/4 without → a beam, not a pick |

Small-workspace shortcut (measured): one Python file → skip Q2–Q4, one flat Q5 (hierarchy "helped 2 of 4,
hurt 1" on >15-line programs, `probe-localization.md` §5). The site list is cut at 6 replace + 6 insert
sites; the 32k state cap is respected by `localize/budget.ts` (max measured request 16.2k tokens, Q6).

### 1.6 Edit class, ranking and the fix-absent detector

| Id | Type | Options | Wording | Consumed as | Measurement |
| --- | --- | --- | --- | --- | --- |
| Q6 `edit_class` + paired Nouls `needs_<class>` | Choice + 5 Nouls in one request; state = goal failures, function listing, `buggy_line` (top site) | `substitute_one_token`, `insert_fragment`, `delete_fragment`, `reshape_line`, `insert_new_line`, `change_several_lines`, `none_of_these`; each with definition + example | "Which kind of edit turns `buggy_line` (line `L<k>` of `program`) into the correct line so that `tests` pass? Read the options literally." | **soft prior only**: reorders §2 sources (e.g. `insert_new_line` p ≥ 0.5 moves templates/donors before mutation and promotes insert sites); never removes a source | `lit-guided-synthesis.md` §5.3: the anchor is right 29/29 but the substitute-vs-insert distinction "needs to be its own Choice (D1)"; change-kind Choice on SWE is only 53 % strict (`probe-swebench-understanding.md` Q1) and fix-kind on QuixBugs 62–75 % (`probe-donor-and-templates.md` §3), hence "do not gate on it" in both files. **The exact `edit_class` wording above is unmeasured** (§8 risk 3 experiment) |
| Q7 `fix` / `is_fix_<cand>` | N ≤ 10: Choice + escape; 10 < N ≤ 60: Choice + compact Noul per candidate in the same request (ranked by Nouls); N > 60: compact Nouls in concurrent chunks ≤ 254, then Choice over the Noul top-5 | candidate text as option description; `state.candidates` for Nouls; the **unchanged line is never an option** | Choice: "Which option is the corrected line that, put in place of `buggy_line`, makes every test in `tests` pass, including the tests that currently fail? Read each option literally … Choose `none_of_these` if no option is a correct fix." Noul: "Is `candidates.cand_xx` the corrected line: put in place of `buggy_line`, does it make every test in `tests` pass?" (criteria once in `state.correct_fix_criteria`) | ranked list; verify top-K in order | `probe-selection.md`: Choice top-1 36/40 at N=10, Nouls 39/40 at N=50, compact Nouls 32/40 top-1 / 36/40 top-3 at N=254 ($0.00077, 331 ms), two-stage 33/40 with fix shortlisted 39/40; `probe-question-design.md` §6: dropping the unchanged line → 20/20 test-passing top picks, 0 confident misses. Already implemented in `src/synth/rank` |
| (code) `fixProbablyAbsent` | computed from Q7 | – | – | skip verification at this site unless it is the last site; log | `probe-selection.md` detector: `P(escape) − p_max ≥ 0.10` AUROC 0.916, 82 % detection / 13 % false alarms; Nouls `max < 0.5` 71–75 % / 16–21 %. Also `probe-donor-and-templates.md` §1: "top ∈ {escape, buggy line}" detects an absent donor 35/36 |
| Q8 `hole_<k>` | Choice per identifier hole in a donor/template line, **one hole per request** | in-scope identifiers (+22 builtins), keys `ident_<name>`; callables only for call-target holes | "Which identifier, in scope in `program`, fills `__HOLE__` in `replacement_templates.hole_k` so that the completed line at `program.L<n>` makes all `tests` pass?" | top-2 fillings enter the candidate set (both are then ranked by Q7 and tested) | `probe-donor-and-templates.md` §2: changed identifiers 13/13 leak-free (P p50 0.98); misses on unchanged slots are call-target holes and `a`/`b` pairs, hedged at 0.2–0.4 → keep top-2 |
| Q9 `next_token` | Choice per beam step, W hypotheses per request, grammar-filtered options | legal next tokens for the prefix (code), `end_of_line`, escape | "`partial_line` is the beginning of the correct replacement line … Which single Python token comes immediately next in the correct line? Choose `end_of_line` if … Answer literally: exactly one token, not a whole expression." | last-resort source; top-3 completed lines become candidates | `probe-token-synthesis.md`: teacher-forced 84 % / 96 % top-1/top-3; beam W=3 + grammar 20/40 any-of-top-3 passes, $0.0037 and 3.3 s per line; `lit-guided-synthesis.md` §5: slots 91–93 % top-1, S2 diff-fill 23/25 at B=3 |

### 1.7 Progress, the beam of bases, revert

All progress arithmetic is code (`progress()` and `route()` in `src/synth/verify/progress.ts`):
`allPass`, `improved = after.passed > before.passed`, `regressed = newlyFailing > 0 || after.passed <
before.passed`. Basis: `probe-progress-judgment.md` design point 3 — "when the two runs cover the same test
set, all three Nouls are themselves pure functions of code-computed numbers", the code-routed move matched
240/240, and Jev's free Choice over policy options misread "1/7 → 2/7" as "did not help" on 6/10 partials.

| Id | Type | Wording | Consumed as | Measurement |
| --- | --- | --- | --- | --- |
| Q10 `program_correct`, `made_progress`, `broke_something`, `closeness` | 3 Nouls + 5-level Score, one request, state = measured `both` shape plus `newly_passing_tests` / `newly_failing_tests` numbers | verbatim from `probe-progress-judgment.md` (reused in `src/synth/verify/questions.ts`) | **consistency check only**: a confident (≤0.3 / ≥0.7) disagreement with the code verdict is logged as a `synth` event and counted; ≥ 3 in a run flags the runner parser; `closeness` E[level] orders the two bases when their pass counts tie | 240/240 on all three Nouls (`both`), Score argmax = bin 230/240, $0.00007 per request |

**Beam of bases** (prototype improvement 1): a candidate that passes some of the goal's tests and breaks
nothing is not committed; it becomes `bases.improved` (≤ 1 at a time, replaced only by a strictly better
one on `passed`, ties broken by `closeness`). The current source's ranked queue at the current site is
finished first (the prototype's three trap cases `kth`, `sqrt`, `topological_ordering` all had a better
candidate still in the round-1 queue: `sqrt`'s fix was at Jev rank 3, `prototype-baseline.md` failure
taxonomy). Only when every source is exhausted for the goal is the improved base committed as a partial
step (its full-suite run showed no regression by construction). The three genuine two-step repairs
(`find_first_in_sorted`, `minimum_spanning_tree`, `sieve`) stay reachable: after the partial commit the
goal is re-clustered from the new baseline and searched again next step.

**Revert-on-regression**: a candidate whose full-suite run has `newlyFailing > 0` is discarded before any
Proposal exists (nothing to revert in the real workspace). The only reverts the real workspace ever sees
are (a) the outer replan `revert_changes` directive (§4.4), answered with a reverse `patch` of the last
committed candidate, and (b) a committed partial base whose follow-up goal is parked twice: then the
synthesizer proposes the reverse patch and marks the goal `parked` with reason `partial reverted`.

### 1.8 The overfit guard (advisory, unmeasured)

| Id | Type | Wording | Consumed as |
| --- | --- | --- | --- |
| Q11 `genuine_fix` | Noul, criteria with examples, state = `{ task, failing_test_before: {input, expected, actual}, diff, tests_after: {passed, total} }` | "Does `diff` fix the cause of `failing_test_before`, so that the function is correct for inputs like it, rather than only making the listed tests pass?" true: "the change corrects the operator, bound, argument, guard or value that produced `actual`, and the same reasoning would hold for other inputs" (examples: off-by-one bound fixed; swapped arguments restored). false: "the change special-cases the tested inputs, deletes or bypasses the failing behaviour, or hard-codes `expected`" (examples: `return [1,2,3]`; a condition on the exact test input; deleting the loop). | When two or more candidates pass the full suite in the same round, prefer the one with the higher `genuine_fix`; when only one passes and p < 0.3, commit it anyway (tests are the oracle, JEV-ONLY.md non-negotiable 2) but record `openProblems: ["possible overfit: <diff head>"]` and, before `done`, run the behavioural-clustering check below |

Why it exists: the prototype's `depth_first_search` "repair" (`any(nextnode for nextnode in
node.successors)`) merely satisfied the 5 tests (`prototype-baseline.md`, "Alternative fixes and test
overfitting", correct-by-inspection 31/40 vs 32/40 test-passing); Ye et al. found 53 % of plausible QuixBugs
Java patches overfit (`lit-search-based-repair.md` §4). Code-side complement (no Jev): when several
candidates pass, run them on 5–10 generated inputs (mutated test inputs: empty, singleton, duplicated,
negated) and cluster by output (`lit-guided-synthesis.md` row 10, AlphaCode); a candidate alone in its
cluster is preferred over one that disagrees with the majority. **Neither the Noul nor the clustering is
measured**; §8 risk 1.

## 2. Candidate sources and their order

All sources are code, deterministic and compile-filtered (`src/synth/mutate`, `templates`, `donor`, `beam`;
`CandidateSource.enumerate(site, opts)` in `src/synth/types.ts`). Order per site, before Q6 reordering:

| # | Source | What it enumerates | Cap / size | Coverage evidence | Ranking evidence |
| --- | --- | --- | --- | --- | --- |
| 1 | **mutation, depth 1** of the site line | 30 token-level operators: relational/arithmetic/boolean/augmented swaps, off-by-one, index/slice flips, argument/operand swap, `not`, constant ↔ identifier ↔ literal (pool = literals in file + failing tests), identifier substitution **restricted first to the enclosing function's names** (median 9 on QuixBugs, 116 repo-wide on SWE), attribute substitution, builtin swap, return tweaks, wrap in `max`/`min`/`abs`/`list`, drop/prepend term, guard conjunct/disjunct, `** 2`, `qualify_name` (`f(x)` → `self.f(x)`), `comp_filter` | ≤ 254 per request; larger sets go to two-stage Nouls in parallel chunks | QuixBugs: 34/36 modified lines at depth 1, 36/36 at depth ≤ 2 (`coverage-study.md`); gold fix first-order on 38/40 in the probe library (`probe-selection.md`); SWE: 33/78 modified lines, of which `qualify_name` alone 19 | prototype 25/33 fix at Jev rank 1 when the true line was ranked; 31/33 ≤ 3 |
| 2 | **fix templates** at the site and its insert gaps | guard insertion (`if x is None: return …`, `if not xs: raise …`, copying a sibling's raise), guard extension, missing import (verbatim import lines from the repo), attribute/callee change with the new name in scope, add parameter with default + add keyword at call sites (composite, multi-edit), wrap value in a call, `elif`/`else` branch cloning a sibling branch, insert `x.append(y)` / `x.add(y)` / `y = x` / `return x` over in-scope names | ≤ 60 per family, ordered by literature yield | QuixBugs insertions 4/4 (`insert_method_call_scope`, `insert_assign_scope`); SWE templates fire on 16/106 hunks and are the **only** source for `guard_insertion` (2), `add_parameter_default` (2), `add_branch_copy` (1); TBar catalogue in `lit-search-based-repair.md` §1 | insertion Choice 3/4 at N ≤ 50 (`probe-selection.md`, by kind) |
| 3 | **donor lines** with ≤ 2 substitutions | repo lines indexed by identifier-blanked shape; same function, then same file, then repo; each substituted identifier must exist in the file or the failing test; holes beyond what code can bind are filled by Q8 (top-2) | ≤ 100 per site | SWE: donor+≤1 sub 82/199 fixed lines, ≤2 subs 109/199, shape 139/199; **the priority source for SWE inserted lines** (58 % of the 121 insertions are a repo line with ≤ 2 subs) (`coverage-study.md`); ladder `units` (sibling function is the donor) and `tagcloud` (import) | donor Choice 35/36 own-program, 32/36 at 254 options; "buggy line back" as the no-donor sentinel 35/36 (`probe-donor-and-templates.md`) |
| 4 | **composite**: depth-2 mutations of the site line; pairs of the top-10 single edits at one site; coupled edits from the signature template across files | only after 1–3 are exhausted at the site | QuixBugs `mergesort` (`== 0` → `<= 1`) and `shortest_paths` need depth 2 (`coverage-study.md`); ladder `table` needs signature + body + caller as one unit (README: h2 or h3 alone break 6 tests) | **unmeasured** at this size; ranking of second-order pools was never asked (§8 risk 2) |
| 5 | **token beam** (grammar-guided), routes template → W=3 beam | new line at the site or insert gap, ≤ 25 tokens | ≤ 48 requests per site (`DEFAULT_MAX_REQUESTS`) | 20/40 lines (any of top-3 passes) with W=3 + grammar; portfolio 27–28/40 (`probe-token-synthesis.md`); fails on additive fixes and lines ≥ 14 tokens | slots 90–93 % top-1 (`lit-guided-synthesis.md`) |
| – | **test-derived values** | literals from the failing assertion (`expected`, its type, its length) feed the constant pools of 1–3 and the vocabulary of 5; not a source on its own | – | vocabulary from file + tests covers 100 % of QuixBugs and 72 % of SWE fixed lines (`coverage-study.md` (c)) | – |

Reordering by Q6 (soft): `insert_new_line` ≥ 0.5 → 2, 3, 1, 4, 5 and insert sites first; `reshape_line` →
1 (permutation operators first), 4; `change_several_lines` → 4 (composite/signature) before 1. Nothing is
skipped; the order only decides which source spends the step budget first.

Vocabulary pre-check (code, free): a site whose failing test mentions a token absent from file + tests
(e.g. `saferepr`, `IDENT_PREFIX`) is flagged `needs_new_name`; sources 1–3 are still run but the goal is
parked after them rather than spending the beam (the coverage study's 15/30 SWE fixes need a token from
outside file + tests, which no source here produces).

## 3. Verification strategy

**Oracle**: the workspace's detected test command (`workspaceInfo.testCommand`; QuixBugs bench uses
`bench/data/quixbugs/run_tests.py`, the ladder uses `pytest -q`, SWE the instance's test files). Tests are
the only accept signal; Jev never marks a fix correct (JEV-ONLY.md non-negotiable 2).

**Shadows, not the workspace.** A candidate is never written into the real workspace by the synthesizer;
the engine's execute stage applies the returned `patch`. Verification uses **shadow lanes**: `L` hard-link
copies of the workspace under the run directory (`cp -al`; new inodes are written for edited files so
hard links are never mutated in place), `PYTHONDONTWRITEBYTECODE=1` and a fresh `__pycache__`-free tree per
lane (the stale-`.pyc` pitfall in `probe-question-design.md` §8). The sandbox runs the command with `cwd`
set to the lane (the existing `Sandbox.run` accepts `cwd`, used by `src/synth/verify/index.ts`
`sandboxRunFn`). Default `L = 4`; each lane is reset from the committed workspace before use.

**Runs per step** (bounded in code, counted in `stepBudget`):

| Run | When | Scope | Count per step |
| --- | --- | --- | --- |
| baseline | first step, after every commit, on resume | full suite | 1 |
| goal-subset | for each verified candidate | only the goal's failing tests plus the tests in the same file that currently pass (`pytest <file>::<test>` ids or `run_tests.py` with a case filter) | ≤ `K_VERIFY` (3, or 5 at site p ≥ 0.9) per site, ≤ 4 sites per source per step → hard cap 12 |
| full-suite regression | the first candidate whose subset run is green (or a partial being held as a base) | full suite | ≤ 3 |
| behavioural clustering | when ≥ 2 candidates pass the full suite | generated inputs, all passers | ≤ 1 batch |

Parallelism: the `K_VERIFY` subset runs of one site go out together on the lanes (wall time ≈ one run).
Basis for spending Jev before tests: every one of the prototype's 8 failures stopped on the 40-test-run cap
while using ≤ 14 of 30 Jev requests (`prototype-baseline.md`, "Budgets"), and the top-3 by Nouls held the
fix on 39/40 at every set size (`probe-selection.md` design point 2), so `K_VERIFY = 3` is where the
measured curve flattens.

**Timeouts**: per test run `min(limits.commandTimeoutMs, 4 × baselineDurationMs + 10 s, wallRemaining)`;
QuixBugs `run_tests.py` already applies 2 s per case (10 s where the case says so). A timed-out candidate
run counts as a regression for routing (`RUN_FAILURE_ID` in the summary) and is never held as a base. A
timed-out **baseline** parks the run's goals with reason `suite too slow` and proposes a `run` of the full
command so the outer loop's judge sees the timeout.

**Per-step budget** (all code): `jevRequests ≤ 30`, `testRuns ≤ 16` (12 subset + 3 full + 1 baseline),
`wall ≤ min(90 s, wallRemaining / 4)` for QuixBugs-sized suites, scaled to `min(8 × baselineDuration, 600 s)`
otherwise. The prototype used a mean of 5.3 requests and 10.3 test runs per program with the same shape of
loop (`prototype-baseline.md` totals).

## 4. Plugging into the outer loop

### 4.1 What one step is, and what Proposals come back

| Situation | `Proposal.action` | `goal` text | `plan` draft |
| --- | --- | --- | --- |
| a candidate committed for goal g | `{ kind: 'patch', diff }` (unified diff over the touched files from `applyCandidate`) | `fix <tests of g> in <path>:<line> (<source>/<op>)` | `done: []` (nothing claimed yet), `remaining`: one item per open/parked goal, `openProblems`: search notes (fix-absent sites, parked reasons, possible overfit) |
| previous step was an executed `patch` | `{ kind: 'run', command: <full test command>, timeoutMs }` | `verify the suite after fixing <tests>` | `done: ['fix <tests> in <path>']` **claimed now**, so the engine's `done_<j>` Noul judges it on this step's parsed test output (DESIGN §6 Plan rule a) |
| step budget hit mid-search | `{ kind: 'run', command: <goal-subset command> }` | `record the failing behaviour of <tests>` | unchanged; the run output enters the window and the next step resumes the search from memory |
| baseline green, guard ok | `{ kind: 'done', summary }` | `all <n> tests pass; <k> fixes committed` | `remaining: []` |
| all goals parked | `{ kind: 'done', summary: 'partial: fixed <k> of <n> failing tests; <reasons>' }` | honest partial | `remaining`: the parked items with reasons in `openProblems` |
| directive `gather_context` | `{ kind: 'read', paths }` for the goal's suspected files not in `contextFiles` | – | unchanged |
| directive `revert_changes` | reverse `patch` of the last committed candidate | `revert <op> at <path>:<line>` | the goal returns to `remaining` |

The `run` after every `patch` is deliberate: it is how the outer loop's record, `workspace.lastTestRun`,
`testsCurrent` and the `task_complete` Noul (whose true-criteria require `lastTestRun.allPassed` and
`testsCurrent`, DESIGN §5.5) see the oracle, and it is the evidence the `done_<j>` Noul needs. It costs one
step and one test run per commit. A successful QuixBugs program is therefore `patch → run` (completion fires
on the `run` step when `task_complete ≥ 0.85`) or `patch → run → done`.

### 4.2 Plan and progress tracking

`plan.remaining` items are written in the fixed form `fix <first_test_id>[, +N more] in <path>` so they are
(a) readable by the engine's Jev stages (intent `plan_still_valid`, risk `plan_mismatch`, completion),
(b) parseable back into goals on resume. Progress is the ledger: `fixed / open / parked` counts are
emitted as `synth` events every step (`{ phase: 'ledger', detail: 'fixed 2, open 1, parked 1' }`) and the
per-step `SearchTrace` (`src/synth/types.ts`) records sites, candidates enumerated/ranked/tested, Jev
requests, test runs, outcome. The completion Noul is not asked by the synthesizer; the engine asks it.

### 4.3 Loops and stuck detection

Internal (code): a goal is parked when every source is exhausted at every site, or after 3 searches
without a commit, or when the vocabulary pre-check says the fix needs an unavailable name and sources 1–3
are exhausted. A parked goal is never re-opened in the same run unless a later commit changes one of its
suspected files (then it returns to `open` with `attempts` kept). `triedDiffs` makes every proposed `patch`
unique, so the engine's `patch:<sha12>` signature cannot reach 3; the `run:<cmd>:<result>` signature can
reach 3 only if three consecutive budget-hit steps run the same subset with the same result, which the
internal rule "a goal with 2 budget-hit steps in a row is parked" prevents. If the outer detector trips
anyway, the replan directive is honoured (§4.4) rather than ignored.

External: the outer loop's loop detector, `max_steps` (40), `max_replans` (5), spend cap and wall time apply
unchanged. The synthesizer reads `ctx.window` to notice a `patch` whose outcome was `failed` (did not apply):
it invalidates the goal's `localizeCache`, re-reads the file and re-localises (the site was stale).

### 4.4 Directives from replan

`change_approach` → the active goal's current source order is rotated (the exhausted set is kept) and the
site beam widened from 6 to 10; `gather_context` → `read` of the goal's suspected files; `fix_environment`
→ a `run` of the test command alone (the synthesizer cannot install anything; the outcome tells the engine
whether the environment works); `revert_changes` → reverse patch of the last commit; `stop_and_report` is
handled by the engine (`replan_stop`).

### 4.5 What 'done' means

`done` is proposed only when (1) the last full-suite run on the committed workspace has `failed == errors
== 0`, `passed > 0`, no timeout; (2) no file under the tests directory was changed by any committed
candidate (code check on the committed diffs); (3) the overfit path in §1.8 has been run (advisory). The
engine's own `task_complete` Noul remains the stop rule; a `done` that the risk stage blocks (e.g.
`plan_mismatch` with `remaining` non-empty on a partial) is proposed at most twice, then the synthesizer
proposes a full-suite `run` and lets the replan stage's `task_impossible` / `stop_and_report` end the run.

## 5. Cost and latency budget per step, from the measurements

Constants: Jev $0.042 per million input tokens; p50 176–331 ms per request depending on state size
(`probe-localization.md` §7, `probe-selection.md`); 128-way concurrency (REPORT §5); QuixBugs test run
0.1–0.5 s, ladder suite 0.11–0.12 s (README matrix), SWE module 5–60 s.

| Stage of one sub-goal step | Requests | Tokens / request | Cost, QuixBugs-sized state (~1–3k tokens) | Cost, SWE-sized (10–16k) | Jev wall |
| --- | --- | --- | --- | --- | --- |
| Q1 attack_first (skipped when 1 goal) | 0–1 | ~1.5k | $0.00006 | $0.0005 | 0.2 s |
| Q2–Q3 repo file localisation (once per run, cached) | 0–5 | 11–16k | – (1 file: skipped) | $0.0013 (Q6 $0.0011 + Q3 $0.0002) | 0.3 s × ≤ 4, concurrent |
| Q4 functions (per beam file, once per goal) | 0–5 | 2.5k (max 12.6k) | – | $0.0005 | 0.2 s |
| Q5 lines (per function) | 1–5 | ~1.2k (D) … 5k | $0.00005 each | $0.0002 each | 0.2 s, concurrent |
| Q6 edit class | 1 | ~1.5k | $0.00006 | $0.0005 | 0.2 s |
| Q7 rank (per site × source) | 1–3 | 1.3k (N=10) … 18k (254 compact Nouls) | $0.00005–0.00077 | $0.0008 per 254-chunk; 1,641 mutants ≈ 7 chunks ≈ $0.005 | 0.2–0.35 s per request, chunks concurrent |
| Q8 holes (donors only) | 0–3 | ~1.5k | $0.00006 each | $0.0005 each | 0.2 s |
| Q9 token beam (last resort) | ≤ 31 | 2.8k | $0.0037 per line | ~$0.02 per line | 3.3 s |
| Q10 progress consistency (per committed / held candidate) | 1 | ~1k | $0.00007 | $0.0001 | 0.2 s |
| Q11 genuine_fix (per passer) | 0–1 | ~2k | $0.0001 | $0.0006 | 0.2 s |
| **typical step (sources 1–3, no beam)** | **5–10** | | **$0.001–0.003** | **$0.01–0.02** | **1.5–3 s** |
| **worst step (all sources incl. beam)** | **≤ 30** | | **≤ $0.008** | **≤ $0.05** | **≤ 8 s** |

Test side per step: 1 baseline + ≤ 12 subset (on 4 lanes → ≈ 3 rounds) + ≤ 3 full. QuixBugs: ≈ 2–5 s;
ladder: ≈ 2 s; SWE (30 s module): 4 rounds × 30 s + 3 × 60 s ≈ 5 min, which is the binding constraint and
why `K_VERIFY = 3`, the lanes and the goal-subset command exist. Whole-task expectations: QuixBugs 2–3
steps, ≤ $0.01, ≤ 20 s (prototype measured $0.0009 and 3.2 s mean for the single-round version); ladder 3–8
steps, ≤ $0.03; SWE ≤ 40 steps, ≤ $0.5 Jev, wall dominated by tests (30 min default cap → ≈ 6–40 steps).

## 6. Predictions, with the measurement each rests on

### 6.1 QuixBugs (40 programs, tests as the only oracle)

Baseline to beat: prototype **32/40 test-passing, 31/40 correct by inspection**, $0.035 total
(`prototype-baseline.md`). Per failure, what this design changes and the evidence:

| Program | Prototype failure | Design element | Evidence | Expected |
| --- | --- | --- | --- | --- |
| `reverse_linked_list` | fix_not_in_candidates (insert `prevnode = node`) | insert sites + `insert_assign_scope` template + donor 2-sub | template covers it (`coverage-study.md` per-program row); insertion point 1/1 given the statement (`probe-donor-and-templates.md` §4); insert-mode ranking 3/4 at N ≤ 50 | likely |
| `shunting_yard` | fix_not_in_candidates (insert `opstack.append(token)`) | same; `insert_method_call_scope` | template + donor 1-sub cover it; Q5b gap Choice 1/1 given statement | likely |
| `wrap` | fix_not_in_candidates (insert `lines.append(text)`) | same | covered; but Choice P(fix) ≤ 0.27 at every N and Nouls 0.35–0.36 (`probe-selection.md` per-program row) → depends on the test oracle over top-3 | 50/50 |
| `shortest_paths` | two-edit replacement | composite (depth-2) source | depth ≤ 2 covers it (`coverage-study.md`); ranking at depth-2 pool size unmeasured; Choice never picked it (escape won at N=50/254) | unlikely |
| `kth`, `sqrt` | greedy-progress trap | beam of bases: finish the queue before switching | `sqrt` fix at Jev rank 3 in round 1; `kth` fix at rank 182/189 (a false lead `k - 1` outranked it) | `sqrt` likely, `kth` unlikely |
| `lis`, `mergesort` | localisation_missed (true line rank 6, p 0.02–0.03) | SBFL top-3 ∪ Jev top-3; widen to all lines when the beam is exhausted | D∪C top-3 covers 38/40; Ochiai Einspect ≤ 5 on 34/38 (`lit-search-based-repair.md` §6); `mergesort` also needs depth-2 | `lis` likely, `mergesort` 50/50 |
| `depth_first_search` (passes tests, wrong fix) | overfit | Q11 guard + behavioural clustering | unmeasured | may flip to the gold `nodesvisited.add(node)` (donor/template covers it, insertion 1/1) |

Prediction: **35–37/40 test-passing (87–92 %), 34–36 correct by inspection**, ≤ $0.005 and ≤ 20 s per
program. The floor is the prototype's 30/40 repaired in both of its runs (run-to-run flips sit in the
0.03–0.30 band, `prototype-baseline.md` "Run-to-run stability"); the structural ceiling of the sources is
40/40 (`coverage-study.md`). The success criterion in `docs/JEV-ONLY.md` (≥ 60 % under $0.05 and 2 min) is
already met by the prototype; the design's marginal value here is +3–5 programs and the absence of the
greedy trap.

### 6.2 Ladder (12 hand-made multi-hunk tasks, `bench/data/ladder`)

| Task | Hunks / kinds | Why the design reaches it (or not) | Expected |
| --- | --- | --- | --- |
| inventory, grades, textstats | 2 independent hunks: operator, off_by_one, rename, call_args | hunks independent (README: each alone fixes ≥ 1 test); all kinds are depth-1 mutations (`rel_swap`, `off_by_one`, `ident_sub`) and `reverse=True` is an add-keyword template; two sub-goals, two steps each | 3/3 |
| account, calendar_utils | 3 independent hunks, same kinds | same; `dst.withdraw` → `dst.deposit` is `attr_sub`; 3 sub-goals | 2/2 (some risk of one mid-band flip) |
| profiles, stats | 1 inserted guard | `guard_insertion` template (SWE: pylint-4970, requests-2931 reachable only by it); `stats` copies a sibling's raise (donor 1-sub); insert gap Choice 4/4 given statement | 2/2 |
| tagcloud | missing import | `missing_import` template / donor verbatim (SWE: import lines exist elsewhere 2/2) | 1/1 |
| shipping | wrong constant in a dict (500.0 → 50.0) | `const_sub` with the literal pool from the failing tests (`coverage-study.md` (c): test literals) | 1/1 |
| events | wrong attribute name | `attr_sub` from attributes seen in the file; identifier holes 13/13 | 1/1 |
| table | 3 coupled hunks across 2 files (signature + body + caller) | README: h2 or h3 alone break 6 tests → only the composite `add_parameter_default` + call-site template as one unit can reach it; unmeasured | 0–1 |
| units | 3-line body rewrite from a sibling function | donor 2-sub per line, three lines as one composite; unmeasured at 3 lines | 0–1 |

Prediction: **8–10/12**, 3–8 steps each, ≤ $0.03 per task. This is the rung the design is *for*; §8 risk 3
is the experiment that measures it.

### 6.3 SWE-bench Verified (the 30 checked-in instances)

Two independent gates, both measured: localisation (`probe-swebench-understanding.md`, chained view) and
proposal coverage (`coverage-study.md`, union with ≤ 2-sub donors). Per instance:

| Instance | Q6 file rank | Q2 fn rank | Q4 line rank (±3) | Hunks reachable (2-sub union) | Test-driven note | Expected |
| --- | --- | --- | --- | --- | --- | --- |
| django-15315 | 1 | 1 | 1 | 1/1 | `return hash(self.creation_counter)` donor 1-sub | **candidate** |
| django-15572 | 1 | 2 | 1 | 2/2 | two `comp_filter` mutations, two sub-goals | **candidate** |
| django-16100 | 2 | 1 | 3 | 1/1 | `with transaction.atomic(...)` exists twice in the file; multi-line wrap composite | candidate (composite unmeasured) |
| django-15916 | 1 | 1 | 1 | 4/4 | copy-a-neighbour + `qualify_name`; 4 hunks → 3–4 sub-goals | candidate |
| pytest-10051 | 1 | 1 | 1 | 2/2 | new 3-line `clear()` copies neighbours + call-target change | candidate |
| pylint-4970 | 1 | 3 | 1 | 1/1 | `guard_insertion` | **candidate** |
| pylint-4604 | 1 | 3 | 1 | 2/3 | the unreachable hunk (`import platform`) is unrelated to the failing test | candidate |
| requests-1142 | 1 | 1 | 1 | 2/2 | move a line into a new `elif` branch (`add_branch_copy`) | **candidate** |
| requests-2931 | 1 | 2 | 1 | 2/2 | unwrap call + 2-line guard | **candidate** |
| pylint-6386 | 17 | 2 | 11 | 8/8 | reachable but file rank 17 and 4 files | unlikely |
| the other 20 | – | – | – | 0/n or < all needed hunks | new logic, new names, idiom changes (`coverage-study.md` groups 1–3) | no |

Nine instances pass both gates for the tests that matter. The unmeasured gate between them is ranking at
SWE candidate-set sizes: median 1,641 depth-1 mutants per line (3 % of lines ≤ 255) versus the measured
Noul decay 98 % → 78 % top-1 from 50 to 254 candidates (`probe-selection.md`), partially offset by
restricting identifier substitution to the enclosing function first (median 116 → far fewer names) and by
donors being few (≤ 100). Prediction: **3–6/30 (10–20 %) pass their FAIL_TO_PASS tests under the local
evaluator, central 4**; 0 of the other 20 by construction. Any solve is a result for a system with no
generating model (`docs/JEV-ONLY.md` success criteria); the honest ceiling is 9–10/30 until a name source
beyond file + tests exists.

## 7. Modules for implementation (files under `src/synth/`)

Existing and reused as-is (already written for the measured questions): `py/` (tokenizer, structure,
edits, similarity), `mutate/` (30 operators, second-order), `templates/` (8 families), `donor/` (shape index,
adaptation, hole Choices), `beam/` (grammar, token beam, template route), `localize/` (Q2–Q5 pipeline with
beams and the 32k budget), `rank/` (Q7 by N, detector), `verify/` (runners, `progress`, `route`, Q10,
`pickNextFailingTest`, `applyCandidate`), `sbfl/` (tracer, Ochiai), `types.ts`.

New, all under `src/synth/search/`:

| File | Responsibility | Jev questions | Key exports |
| --- | --- | --- | --- |
| `memory.ts` | `SearchMemory` per run; rebuild from `plan.remaining` + baseline on resume; `triedDiffs`; `SearchTrace` accumulation | – | `getMemory(runId)`, `rebuildFromPlan`, `planItemFor(goal)`, `parseGoalItem` |
| `goals.ts` | cluster failing tests into goals from tracebacks / SBFL / one-per-test; goal status transitions; parking rules | Q1 via `verify.pickNextFailingTest` (goal-level options); optional `same_cause_<t>` (off) | `clusterFailures`, `pickGoal`, `park`, `reopenOnChange` |
| `subgoal.ts` | §1.4: sources × sites loop, ranking, `K_VERIFY`, fix-absent skip, hold/commit/park; per-step budget | Q6 `edit_class` (+ paired Nouls), Q7 via `rank`, Q8 via `donor.holes`, Q9 via `beam` | `searchSubGoal`, `orderSources`, `EDIT_CLASSES` |
| `bases.ts` | beam of bases (≤ 2), replacement rule, partial commit, tie-break by `closeness` | Q10 via `verify.judgeProgress` (consistency) | `holdAsBase`, `bestBase`, `commitPartial` |
| `shadow.ts` | shadow lanes in the run dir (`cp -al`, no bytecode), apply candidate to a lane, reset, `runSubset`/`runFull` through `Sandbox.run({ cwd })`, timeouts from the baseline | – | `createLanes(L)`, `withLane`, `subsetCommand(runner, tests)` |
| `guard.ts` | §1.8 overfit guard: Q11 Noul, generated-input behavioural clustering, preference rule | Q11 `genuine_fix` | `overfitCheck`, `clusterByBehaviour` |
| `composite.ts` | depth-2 pairs at one site, top-10 single-edit pairs, cross-file signature+call-site units | – | `compositeSource` (a `CandidateSource`) |
| `proposal.ts` | Proposal builders: `patch`, `run` (full / subset), `done` (green / partial), `read`; plan draft in the fixed item form; `synth` events | – | `proposePatch`, `proposeRun`, `proposeDone`, `proposeRead` |
| `directive.ts` | §4.4 mapping of replan directives to actions/state changes; stale-site detection from `window` | – | `handleDirective`, `patchFailedLastStep` |
| `budget.ts` | per-step counters (`jevRequests`, `testRuns`, wall), `K_VERIFY`, lane count, timeout formula | – | `stepBudget`, `verifyCount(siteP)`, `runTimeout(baseline)` |
| `index.ts` | `createSynthesizer(opts): Synthesizer` wiring `synthesize(ctx)` per §1.2; replaces the placeholder in `src/synth/index.ts` | – | `createSynthesizer`, `TestDrivenSynthesizer` |

Tests to add under `test/unit/synth/search/`: goal clustering from pytest tracebacks and from
`run_tests.py` JSON; the route table of §1.4 with scripted rank/verify results (commit / hold / park /
budget); plan item round-trip on resume; shadow lane apply + reset with hard links; the fixed-form plan
strings; directive handling; a mocked end-to-end on `bench/data/ladder/tasks/inventory` with a scripted
decider (no live Jev).

## 8. The three biggest risks and the experiment that retires each

**Risk 1: plausible-but-wrong commits accumulate.** Tests are the only oracle; the prototype overfit 1/40
(`depth_first_search`), Ye et al. report 53 % overfitting among plausible QuixBugs Java patches, and a
multi-step engine can commit a wrong partial that makes the next sub-goal unreachable. Q11 and behavioural
clustering are unmeasured. *Experiment* (`experiments/overfit-guard/`, ≈ $0.05): take the 32 prototype
winners plus the 240 labelled candidates of `experiments/progress/candidates.json` (fix / partial /
regression / no_change) and the 3 known non-gold passers from `lit-guided-synthesis.md` §5.3; ask Q11 on
each with the measured state shape; report AUROC of `genuine_fix` against "gold-equivalent vs
test-only", the precision at 0.3 and 0.7, and how often behavioural clustering on 8 generated inputs
separates the equivalent (`next_permutation`, `max_sublist_sum`) from the overfitted (`possible_change`
`<= 0`, `depth_first_search`). Retired if AUROC ≥ 0.85 and the two overfits are separated; otherwise the
guard stays advisory and the design accepts the measured overfit rate.

**Risk 2: candidate sets on real code are too large for the measured ranking.** SWE lines have a median of
1,641 depth-1 mutants (3 % ≤ 255) and 116 in-scope names; ranking was measured at ≤ 254 (Nouls 78–80 %
top-1 at 254) and the two-stage shortlist at 254; batches of several 254-chunks were never run
end-to-end, nor was depth-2 or the "enclosing-function names first, widen on miss" policy. *Experiment*
(`experiments/rank-at-scale/`, ≈ $0.15): for the 33 SWE lines reachable by depth-1 mutation and the 21
ladder hunks, enumerate the full first-order set with function-scope names first, rank with parallel
254-chunk compact Nouls then the shortlist Choice; report rank of the gold line, cost and p50 per line for
(a) function-scope names only, (b) file names, (c) with depth-2 pairs added; and the fix-absent detector's
false-alarm rate on the (a) sets that do not contain the gold. Retired if gold ≤ 3 on ≥ 70 % of lines at
(a) with ≤ $0.01 and ≤ 3 s per line; otherwise the design caps identifier substitution at function scope
and routes the rest to donors.

**Risk 3: the decomposition itself fails: wrong goal clustering, coupled edits, or the beam of bases
still trapping.** Independence of hunks was only verified on 5 ladder tasks; `table` is a known coupled
case that per-hunk verify-and-keep cannot reach; the `edit_class` wording is unmeasured; goal clustering
by traceback frame has no measurement at all. *Experiment* (`experiments/ladder-e2e/`, ≈ $0.30): run the
engine in `jev-only` mode on all 12 ladder tasks, 3 repeats, with the bench's `ladder` suite; record per
task: solved, steps, commits, reverts, parks, goals formed vs hunks, whether `edit_class` matched the
`kinds` label (top-1 and paired-Noul ≥ 0.5), and for `table` whether the composite signature unit was
enumerated and where Jev ranked it. Also re-run the prototype's `kth`, `sqrt`, `topological_ordering` with
the beam of bases versus commit-on-improvement, 3 repeats each, to measure the trap directly. Retired if
≥ 8/12 tasks solve in ≥ 2 of 3 repeats with 0 regressions kept and the 3 trap programs repair in ≥ 2 of 3;
otherwise the fallback is one sub-goal per failing *test* (no clustering) and committing partials
immediately, which is the prototype's behaviour with its measured 32/40.

## 9. Decisions this design takes that differ from the prototype and the probes

| Decision | Prototype / probe behaviour | This design | Basis |
| --- | --- | --- | --- |
| unit of work | whole program per round | one failing-behaviour cluster per step | multi-hunk data: 19/30 SWE, 5/12 ladder (`coverage-study.md`, ladder README) |
| partial improvement | adopted as the new base at once | held as a second base; committed only when the goal's sources are exhausted | 3 trap failures across two prototype runs, fixes still in the round-1 queue |
| progress judgment | code | code; Jev Nouls as consistency only | 240/240 code routing; Jev misread 6/10 partials as a free Choice |
| unchanged line as candidate | present in the anchor probe | never an option | 20/20 test-passing top picks when removed (`probe-question-design.md`) |
| localisation | Jev top-3 → top-5 | Jev top-3 ∪ SBFL top-3, insert gaps, widen to all lines on exhaustion | D∪C 38/40; Ochiai ≤ 5 on 34/38; insertion 4/40 unreachable otherwise |
| ranking | one Choice per line, cap 200 | `rank/` by N: Choice ≤ 10, hybrid ≤ 60, chunked Nouls + shortlist above | Choice 65 % vs Nouls 78–80 % at 254, two-stage 33/40 |
| where tests run | the workspace copy | shadow lanes under the run dir, 4 in parallel | test runs were the binding budget (8/8 failures on the test cap) |
| what the outer loop sees | nothing (script) | `patch` → `run` alternation, fixed-form plan items, honest partial `done` | DESIGN §5.5 completion criteria need `lastTestRun` and `testsCurrent` |
| change-kind / fix-kind Choice | none | `edit_class` as a soft source prior, never a gate | 53–75 % top-1 in both kind probes; "do not gate" in both |

## 10. Sources

`experiments/results/prototype-baseline.md` (32/40, $0.035, failure taxonomy, three improvements);
`probe-localization.md` (D 28/40, D∪C 38/40, SWE file 24/30 and 26/30, calibration bins);
`probe-selection.md` (Choice vs Nouls by N, detector AUROC 0.916, two-stage 33/40, escape cost 2–3/40);
`probe-question-design.md` (unchanged line, actual output, string state, thresholds 0.7/0.5);
`probe-progress-judgment.md` (240/240 code routing, attack-first 16/34, variant B);
`probe-donor-and-templates.md` (donor 35/36, holes 13/13 leak-free, insertion point 4/4, fix-kind 62–75 %);
`probe-token-synthesis.md` (84/96 %, W=3+grammar 20/40, portfolio 27–28/40);
`probe-swebench-understanding.md` (Q6 23/30 #1, Q2 top-5 35/37, Q4 ±3 top-5 94 %, chained 21/30);
`coverage-study.md` (QuixBugs 40/40 union; SWE 6/30 strict, 9/30 2-sub; 1,641 median mutants);
`lit-search-based-repair.md` (rank → validate → judge; Ochiai on QuixBugs; Noul ranking 26/34 over 295 candidates);
`lit-guided-synthesis.md` (slot beams 92 % S2, anchor 29/29, edit class needs its own Choice);
`anchor-probe.md` (13/14, 14/14); `docs/JEV-ONLY.md`; `docs/DESIGN.md` §4–6, §21; `bench/data/ladder/README.md`;
`/Users/prateekjannu/Documents/jev-research/REPORT.md` §7–11, §14. No new live requests were made for this
document.
