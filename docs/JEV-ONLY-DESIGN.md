# JevCode Jev-only synthesis engine: the design to implement ("Ledger + Sieve")

Status: the single architecture for `Synthesizer.synthesize(ctx) → Proposal` in `jev-only` mode, written
2026-09-20 by the synthesizing architect from the four candidate designs in `experiments/designs/`
(`test-driven-decomposition.md`, `contrarian.md`, `repair-search.md`, `grammar-synthesis.md`), the three
judges' verdicts (reach: `experiments/results/judge-1-reach.md`; reliability and cost:
`experiments/results/judge2-reliability-cost.md`; integration: inline verdict) and every results file under
`experiments/results/`. No live Jev calls were made for this document ($0.00). Every number is quoted from a
named file; every design element without a measurement behind it says so and names the experiment in §9.

The spine is the highest-ranked design, **test-driven decomposition** (8/10 with all three judges): a
persistent ledger of sub-goals (one per cluster of failing tests), one verified sub-goal per outer step,
park-not-retry, regressions never kept, partials held as a second base, `patch → run` alternation so the
engine's own record sees the oracle, plan items in a fixed grammar for `--resume`. Grafted onto it, in the
judges' order of value:

- from **contrarian (Sieve)**: budget test runs by *measured cost*, not by count; when the whole candidate
  set at a site fits the run budget, run it all and let `python3` rank (median 3.8 s per QuixBugs program
  at the true line, gold passes 35/36 and is the only passer 25/36); the `widened` brute-force phase over
  every code line of the located function as a later step on single-file workspaces; behaviour clustering
  before any Jev arbitration; `Q_arbitrate` + paired `Q_general` Nouls as the *measured* overfit guard
  (10/10 and 13/14 gold-or-equivalent); the adaptive per-test timeout; pairs of partials across sites.
- from **repair-search**: insert gaps as first-class `Site`s around the top-3 anchors; the global
  verification queue keyed by (base passed desc, Noul p desc); the ranking method per N with 150-candidate
  chunks on repository states; shuffle-and-average re-ask on slow oracles; SBFL top-5 unioned (not
  score-combined) on single-file workspaces; never mutate `def` lines; the guard never overrides tests;
  `hunk-subsets.py` ($0) and `rank-at-scale.mts` ($0.15) as the two decisive SWE experiments.
- from **grammar-synthesis**: the sketch Choice as a one-request reach round after concrete seeds fail and
  before the 31-request token beam (39/40 shape coverage, median 64 options, $0.00019); the K = 5 widening
  rule when P(top) < 0.5 or P(escape) ≥ 0.3; the measured `edit_class` wording as a soft source-order prior
  (28–29/40 top-1, 35–36/40 top-2); slot fill "expand 1 when p(top) ≥ 0.9 else B = 3"; overlap Jev requests
  with test runs.

Corrections the judges required, all applied here: K_VERIFY is sized from the **compact**-Noul curve
(top-3 36/40 at N = 254, not 39/40), or full-criteria Nouls are used where the 39/40 holds (N ≤ 150);
`kth`'s fix was at Choice rank 182/189, so "finish the round-1 queue" does not rescue it, the sieve does;
a lone test-passing candidate is **never** withheld on a Noul threshold (`quicksort` gold Noul 0.15); a
single behaviour cluster of ≥ 2 passers is still arbitrated so the all-overfit `depth_first_search` set
(escape 0.90, max Noul 0.06) is caught; the QuixBugs insertions are counted as *unmeasured end to end*
(the sieve JSONL enumerated 0 gap-site candidates); FAIL_TO_PASS sizes on the 30 SWE instances are 21 × 1,
4 × 2, 3 × 3, one × 10 (`pytest-7205`), one × 21 (`pylint-4604`): 28/30 have 1–3; `pytest-7205` is **not**
coverage-reachable (`saferepr` absent from vocabulary); shadow copies do not use `cp -al` (BSD `cp` has no
`-l`); nothing of the synthesizer is assumed to survive `--resume` except `plan.remaining` and the workspace;
`plan.openProblems` carries human-readable notes only (it is Jev-visible in the risk stage).

---

## 1. Thesis

A Jev-only agent cannot write code, so a task has to become a **queue of failing behaviours** (one sub-goal
per cluster of failing tests) attacked one at a time by a **bounded search whose ranker is the test runner
whenever tests are cheap and Jev only when they are not**. The measurements say each piece holds: code can
propose every QuixBugs fix (union of mutation d ≤ 2, donor ≤ 2-sub, templates: 40/40, `coverage-study.md`)
and 9/30 SWE-bench Verified gold patches; Jev localises the buggy line top-3 on 36/40 with the actual output
in the state (38/40 unioned with per-line Nouls, `probe-localization.md`) and the gold file #1 on 23/30
repositories from the issue text alone (`probe-swebench-understanding.md`); when the true line is known,
running *every* first-order mutant through the suite costs a median 3.8 s at 8-way parallelism and the gold
passes 35/36 and is the *only* passer 25/36 (`contrarian-exhaustive.truth.jsonl`), so on cheap oracles no
ranking loss exists at all and both prototype failure classes `ranking_missed` and the greedy-progress trap
disappear; when several candidates pass, behaviour clustering plus one Jev Choice with paired Nouls picks the
gold or an equivalent 10/10 and 13/14 for $0.0001 per request and rejects the one all-overfit set at escape
0.90 (`contrarian-arbitrate.*.jsonl`); when the oracle is expensive (SWE modules 5–60 s, 1,641 mutants per
line) compact Nouls over ≤ 254 candidates keep the fix in the top-3 on 36–40/40 for $0.00077 and a code-computed
`fixProbablyAbsent` (AUROC 0.916) switches sources before a run is spent (`probe-selection.md`); progress is
arithmetic on test counts that code gets right 240/240 where Jev added nothing (`probe-progress-judgment.md`);
and multi-hunk tasks are reachable because the ladder's five multi-bug tasks have independent hunks that each
fix ≥ 1 test alone (`bench/data/ladder/README.md`), so committing one verified sub-goal per step and
re-baselining composes them. Jev's irreplaceable jobs are the three tests cannot do: *where* to look, *which
failing behaviour* to attack next (16/34 vs 8/34 chance), and *which of several test-passing patches is
genuine*; everything else is code and `python3`.

---

## 2. The algorithm

### 2.1 Persistent state (per `runId`, in memory; durable copy = `plan.remaining` + the workspace)

```ts
interface SearchMemory {
  baseline: TestRunSummary | null;      // full-suite run on the committed workspace (code)
  oracle: OracleModel;                  // §4.1: t_run per scope, per-test timeout, lane count
  goals: Goal[];                        // the ledger, one per failing-test cluster
  bases: Base[];                        // ≤ 2: committed workspace + at most one 'improved' partial
  tried: Set<string>;                   // sha12(diff) of every candidate ever run in this run
  localizeCache: Map<string, LocalizeResult>;   // per goal; invalidated when a suspected file changes
  widenCursor: Map<string, number>;     // per goal: how far the `widened` all-lines phase got (§2.3 phase W)
  committed: AppliedCandidate[];        // commit order, for revert directives
  stepBudget: StepBudget;               // §4.3, fresh each synthesize() call
}
```

`Goal`, `Base`, `StepBudget`, `OracleModel` are written out in §6. Durability rule (test-driven §1.1):
`plan.remaining` carries one item per open or parked goal in the fixed form
`fix <first_test_id>[, +N more] in <path>`; `plan.done` one per fixed goal, claimed on the `run` step that
shows the tests passing. On `--resume` the memory is empty: the first step re-runs the baseline,
re-derives goals from the failing tests and re-attaches them to plan items by test id; `tried` is lost and
lost candidates are re-run at most (test time, never a wrong commit).

### 2.2 One outer step (`synthesize(ctx)`), top level

```
synthesize(ctx):
  mem = memory(ctx.runId); mem.stepBudget = fresh(ctx.limits, mem.oracle)
  if ctx.directive:                         return handleDirective(ctx, mem)             # §5.4
  if lastExecutedAction(ctx.window) is 'patch': return proposeRun(ctx, fullSuite)        # §5.1: make testsCurrent true
  if mem.baseline is null or workspaceChangedSince(mem.baseline):
      mem.baseline = runFullSuite(committed workspace)                                   # 1 run; also measures t_run
      mem.oracle   = fitOracle(mem.baseline)                                             # §4.1
      mem.goals    = reconcile(mem.goals, clusterFailures(mem.baseline), ctx.plan)       # §2.4; keeps parked/attempt state
  if mem.baseline.allPass:                  return proposeDone(ctx, mem)                 # §5.5
  goal = pickGoal(ctx, mem)                                                              # Q1 when ≥ 2 open goals, else the one
  if goal is null:                          return proposeDoneOrReport(ctx, mem)         # every goal parked: honest partial done
  r = searchSubGoal(ctx, mem, goal)                                                      # §2.3
  switch r.kind:
    'commit':  mem.committed.push(r.applied); goal.status = r.allGoalTestsPass ? 'fixed' : 'open'
               return proposePatch(ctx, r.applied, goal, r.note)                         # Proposal.action = { kind:'patch', diff }
    'parked':  goal.status = 'parked'; goal.parkedReason = r.reason
               if not mem.stepBudget.recursed: mem.stepBudget.recursed = true; return synthesize(ctx)  # once
               return proposeRun(ctx, goalSubset(goal))                                  # cheap evidence step
    'budget':  return proposeRun(ctx, goalSubset(goal))                                  # search resumes next step from memory
```

One step = one sub-goal attempt, or the bookkeeping `run` after a commit. The recursion on `parked` is
bounded to one, so the step always yields a Proposal inside `stepBudget`.

### 2.3 The search for one sub-goal (the sieve-or-rank inner loop)

```
searchSubGoal(ctx, mem, goal):
  sites = mem.localizeCache[goal] ?? localize(ctx, goal)          # §2.5: ≤ 6 replace + ≤ 6 insert sites, ranked
  prior = editClassPrior(ctx, goal, sites[0])                     # Q7 (with Q12 in one request when sketches are built); soft order only
  queue = new VerifyQueue(key = (base.passed desc, p desc, sourcePrior desc))    # repair-search §3.1, global across sites
  for phase in [SEEDS, SKETCH, BEAM, WIDENED]:                    # each phase is skipped when exhausted/not applicable
    for base in mem.bases (committed first):
      for site in sites (rank order):
        for source in orderSources(phase, prior, goal.exhausted[site]):
          cands = source.enumerate(site, opts) \ mem.tried \ {site.currentLine} \ vocabFail   # code, compile-filtered, deduped
          if cands.empty: continue
          plan = decideRunPlan(cands, site, mem.oracle, mem.stepBudget)             # §2.4: SIEVE or RANK
          if plan.mode == 'SIEVE':  queue.addAll(cands, p = sourcePrior)             # no Jev; tests rank
          else:
            ranked = rank(ctx, cands, site, goal)                                    # Q8/Q9/Q10 by N
            if ranked.fixProbablyAbsent and not site.isLast and site.kind == 'replace': goal.exhausted[site].add(source); continue
            queue.addAll(ranked.top(plan.k))                                         # k from §2.4; rest stays enumerable for the next step
          results = runQueue(ctx, mem, queue, goal, plan.runsAllowed)                # §4: lanes, adaptive timeout, goal-subset tests
          decision = decide(results, mem, goal)                                      # §2.6
          if decision.kind == 'commit' or 'budget': return decision
          # else: passers empty or all flagged suspect → keep searching this phase
          if mem.stepBudget.exhausted(): return { kind:'budget' }
        goal.exhausted[site].add(source)
    if phase == SEEDS and pairsOfPartials(mem, goal).nonEmpty: test ≤ 10 pairs; commit if one is plausible   # contrarian source 5
  if a 'suspect' plausible candidate was found this step:  return { kind:'commit', applied: it, note:'possible overfit' }
  if mem.bases has an 'improved' base for this goal:       return { kind:'commit', applied: it.candidate, note:'partial' }
  return { kind:'parked', reason: describe(goal.exhausted, sites) }
```

Phases (a source is a phase's *content*; the phase names bound the cost):

| Phase | Sources (§3) | When entered | Sites | Bound |
| --- | --- | --- | --- | --- |
| SEEDS | 1 mutation d1, 2 templates, 3 donors ≤ 2-sub, 4 composite/depth-2 (only after 1–3 exhausted at the site) | always | ≤ 6 replace + ≤ 6 insert | run-cost budget (§2.4) |
| SKETCH | 5 sketch productions → slot fill → concrete re-rank | SEEDS exhausted at the top-3 sites, or `fixProbablyAbsent` at every SEEDS source of a site | top-3 sites (replace and insert) | 1 sketch request + ≤ 12 slot requests per site |
| BEAM | 6 token beam W = 3 + grammar | SKETCH produced no passer and `stepBudget.jevRequests ≥ 35` remain | top-2 sites | ≤ 48 requests per site |
| WIDENED | 1–3 again over **every** code line of the located function(s) (`def` lines excluded), cursor-carried across steps | single-file workspaces only, after SEEDS is exhausted at all sites; on repos only under a `change_approach` directive | all lines of the beam functions | run-cost budget per step; median 23.8 s, max 119 s per QuixBugs program at 12-way (`contrarian-exhaustive.all.jsonl`) |

WIDENED normally runs on the step *after* SEEDS (the SEEDS step returns `budget` with a goal-subset `run`),
which is what turns the two prototype `localisation_missed` programs (`lis`, `mergesort`: true line rank 6 at
p 0.02–0.03) into a second step rather than a park.

### 2.4 The run-cost budget rule (contrarian graft, the central decision of this design)

```
decideRunPlan(cands, site, oracle, budget):
  t_run     = oracle.tRunMs[scope(site)]                      # measured on the goal-subset command, §4.1
  runsLeft  = min(budget.testRunsLeft, floor(budget.testWallLeftMs × oracle.lanes / t_run))
  if |cands| ≤ runsLeft and t_run ≤ SIEVE_MAX_T_RUN_MS (2,000):   return { mode:'SIEVE', runsAllowed: |cands| }
  k = site.kind == 'insert' ? 5 : 3                             # insert: gold statements at Noul 0.33–0.39 (`probe-selection.md`)
  if ranked-set size will be > 60 (compact Nouls):  k = max(k, 5)   # compact top-3 36/40 at N=254; top-5 recovers ≈ 2 more (`probe-selection.md`)
  return { mode:'RANK', k: min(k, runsLeft), runsAllowed: min(k, runsLeft) }
```

Why: at QuixBugs scale ranking cost ≈ verification cost (one 137-candidate Noul request is 253–331 ms and
$0.0003–0.0008, then tests still run) while running all 137 at 8-way is ≈ 3.3 s (`contrarian.md` §3.3,
Table 0.1). The 20–35 % top-1 miss rate of ranking turned into the prototype's extra rounds and its
greedy trap (`kth` fix at rank 182/189, `sqrt` rank 3 tied with a false lead, `prototype-baseline.md`). On
SWE-bench the arithmetic flips (1,641 mutants × 5–60 s), so there Jev orders the queue and the cut is a
*budget*, never a probability threshold: a confident wrong rank costs a step, not the fix. Test CPU is the
price (9.9× the prototype's at the true line, 75.5× for WIDENED, `judge2-reliability-cost.md` §0); it is
`python3` time on idle cores and stays inside the 2-minute criterion (§8).

### 2.5 Localisation for one sub-goal (existing `src/synth/localize`, restricted to the goal)

State: only the goal's failing tests, each with the buggy program's **actual output** (the one wording that
moved top-1, +5 every run, `probe-localization.md` §1), plus the traceback frames when pytest gives them.
Small-workspace shortcut: one Python file → skip Q2–Q4, one flat Q5 (+ Q5n Nouls in the same request).

Site list construction (`search/sites.ts` over `localize/sites.ts`):
1. **Replace sites**: Q5 top-3 lines per beam function (p ≥ 0.05) ∪ Q5n Noul top-3 (single-file) ∪ SBFL top-5
   (single-file) / top-3 (repo) — unioned, never score-combined (Ochiai is top-1 on 7/38 with heavy ties but
   top-5 on 34/38; `lis` Einspect 3.0, `mergesort` 5.0, `lit-search-based-repair.md` §6). `def` lines never.
   Order: Jev evidence by p, then SBFL-only lines by Ochiai.
2. **Insert sites**: the gap after *and* before each of the top-3 Jev anchors (repair-search §1.4; both
   neighbours of the four QuixBugs insertion points are at D ranks 2–5, `probe-localization.md` §3.4), plus
   Q6 `insert_after` top-3 gaps when a statement template exists (4/4 given the statement, 2/4 without:
   a site list, never a pick), plus the gap after the last executed line of the failing test's trace when
   SBFL shows a line the fix never reaches (`shunting_yard`). Insert sites are visited after the replace
   sites of the same anchor, or first when Q5 put ≥ 0.3 on `none_of_these` or Q7 puts ≥ 0.5 on
   `insert_new_line`.
3. Cut at 6 + 6; the 32k state cap is enforced by `localize/budget.ts` (max measured request 16.2k tokens).

### 2.6 Deciding on the results of a run batch (code first, Jev only where tests cannot decide)

```
decide(results, mem, goal):
  plausible = { c : c passes every test of the goal subset AND its full-suite regression run shows newlyFailing = ∅ }
  partial   = { c : newlyPassing ≠ ∅ and newlyFailing = ∅ and not allPass }        # code (progress.ts)
  regressed / unchanged / timed-out → tried, dropped (REGRESSION_RULE; nothing was written to the workspace)
  if |plausible| == 0:
      holdBestPartial(mem, partial)                                                  # ≤ 1 'improved' base, replaced only by strictly more passed; ties by closeness
      return { kind:'continue' }
  if |plausible| == 1: return { kind:'commit', applied: plausible[0] }              # tests are the oracle; no Jev gate (quicksort gold Noul 0.15)
  clusters = clusterByBehaviour(plausible, perturbedInputs(goal))                    # code: ±1 ints, drop/dup element, empty/singleton, swap same-type args; pytest: P2P outcome vector
  arb      = askArbitrate(reps = one min-edit member per cluster (≤ 20), all members when 1 cluster (≤ 5))   # Q15 + Q16, one request
  if arb.pEscape ≥ 0.9 and arb.maxNoul < 0.1:                                        # the measured all-overfit signature (depth_first_search 0.90 / 0.06)
      mem.suspect = min_edit(plausible); return { kind:'continue' }                  # keep searching (gap sites next); committed at step end if nothing better
  pick = arb.choiceArgmax; if arb.noul[pick] < 0.3 and ∃ c: arb.noul[c] ≥ 0.7: pick = c   # DESIGN §5.4 Choice/Noul resolution rule
  return { kind:'commit', applied: pick, fallbacks: other reps }                     # fallbacks proposed on later steps if the judge rejects
```

Measured basis: at the true line 25/36 replacement bugs have exactly one plausible candidate (no decision
at all); on the 10 with 2–5, Choice = gold 8/10, gold-or-equivalent 10/10, min-edit alone 3/10; on the 14
cross-line sets of the brute-force run 10/14 gold, 13/14 gold-or-equivalent, one wrong-line pick
(`detect_cycle`, where the paired Nouls rank a gold-equivalent first) (`contrarian-arbitrate.*.jsonl`).
The guard **never overrides the tests**: a candidate that fails a goal test is never proposed; a candidate
that passes is proposed at step end even when flagged, with `openProblems: ["possible overfit: <diff head>"]`.

### 2.7 Every Jev question

All built with `choice()` / `noul()` / `contextNoul()` / `score()` from `src/jev/questions.ts` (escape option
appended, snake_case keys, criteria as definition + examples), asked through `ctx.ask('propose', …)` so
they land in `decisions.jsonl`, `jev.jsonl`, the pane and the meter. Targets are named by backticked path;
nothing asks Jev to count, compare numbers or pick a policy. Wordings marked **measured** are verbatim from
the cited file.

| Id | Type | Instructions (wording) | State / option-set construction (code) | Criteria | Consumer in code | Measurement |
| --- | --- | --- | --- | --- | --- | --- |
| **Q1** `attack_first` | Choice | **measured** (`probe-progress-judgment.md` Part 3, neutral): "Which entry of `failing_tests` should the repair attack first?" | `{ task, failing_tests: { <test_id>: { call\|input, expected, actual, status } } }`, ≤ 10 open goals keyed by first test id, description = failure text; + `none_of_these` | – | `goals.ts pickGoal`: argmax if it beats the runner-up by > 0.02 (`DEFAULT_TIE_MARGIN`), else code tiebreak (fewest tests, shortest input, fewest attempts); skipped when one goal | simplest-first 16/34 vs 8/34 random, MRR 0.67, escape mass 0.10 |
| **Q2** `fix_file_<path>` | Noul × ≤ 250 per request, batched concurrently | **measured** (`probe-swebench-understanding.md` Q6): "Must the file `<path>` (listed in `files`) be modified to fix `issue`? Apply `criteria`." | `{ issue: { repository, problem_statement }, criteria: { yes_when, no_when }, files: [paths] }`, every non-test `.py` path | `yes_when`: "the code change that fixes the issue lands in this file: it defines the function, class, table or constant whose behaviour the report describes as wrong or missing"; `no_when`: "the file merely imports, calls or tests the code that is fixed elsewhere, or is unrelated to the symptoms" | `localize/`: **by rank, never threshold** → top-5 beam (precision at 0.5 is only 0.54) | gold #1 23/30, ≤ 5 28/30, ≤ 10 30/30, MRR 0.85, $0.0011/instance |
| **Q3** `fix_file_confirm_<path>` | Noul × ≤ 10 | **measured** (Q3 outline): "Must the file `files["<path>"]` be modified to fix `issue`? Answer yes only if the code change that fixes the issue lands in this file." | beam files with `top_level_symbols` (≤ 40) | true "the fix edits code in this file" (+2 ex.); false "the fix does not touch this file" (+2 ex.) | re-rank the beam, keep top-5 | gold first 31/33 vs 28/33 paths only |
| **Q4** `fix_function` | Choice per beam file | **measured** (Q2): "`file` is the source file that must be edited to fix `issue`. Which entry of `file.functions` must be modified (its body changed, or new code inserted directly into it) to fix the issue? If the fix is code outside every function, pick `module_level_code_outside_any_function`." | `file.functions: { key: "method X.y, line N: def …" }` (nested classes flattened) + module-level key + escape | – | global top-5 by P(file) × P(fn); escape ≥ 0.5 → module-level site added | top-1 19/37, top-5 35/37, MRR 0.70 |
| **Q5** `buggy_line` | Choice over code lines of one function | **measured** (variant D): "Which line of `program` contains the bug? Pick the single line that must change so that the function is correct. Choose `none_of_these` only if no listed line is faulty." Task text adds "`failing_test_run` shows what the buggy program actually did on one failing test." | `{ task, program: { L<n>: text }, tests: [≤ 3 {input, expected}], failing_test_run: { input, expected, actual } }`; keys `line_<n>`, description = line text (+ enclosing def when the text repeats); centred window ≤ 254 | – | top-3 anchors (p ≥ 0.05) → replace sites + insert gaps; P(escape) ≥ 0.3 → insert sites first; P(top) ≥ 0.9 → that line alone is tried first (92 % right) | top-1 28/40, top-3 36/40, MRR 0.805, ~1,200 tokens, $0.00005, p50 176 ms; SWE Q4 ±3 top-5 94 % |
| **Q5n** `line_<k>` | Noul per code line, same request (single-file only) | **measured** (variant C): "Is line `program.L<k>` the line that must change to fix the bug in `<fn>`? Judge this line only; other lines are judged separately." | same lines; criteria once | true "This line contains the defect: changing this line, and only this line, makes every test pass. The wrong operator, bound, argument, index, condition or return value is on this line." (+4 ex.); false "This line is correct as written. It may compute a value the faulty line misuses, be a `def` line, or an unrelated statement." (+3 ex.) | top-3 unioned with Q5's top-3 (covers 38/40); exactly one line ≥ 0.9 → short-circuit (17/17) | top-1 24/40, top-3 35/40; 3.3× tokens |
| **Q6** `insert_after` | Choice over gaps | **measured** (`probe-donor-and-templates.md` §4): "Where in `program` must `missing_statement` be inserted so that all `tests` pass?" | `before_l1`, `after_l<i>` ("insert directly after L<i>: <line>") for every line of the function + escape; `missing_statement` = the template statement | – | top-3 gaps become insert sites for that statement family; asked only when a statement is known and > 6 gaps | 4/4 given the statement, 2/4 without |
| **Q7** `edit_class` | Choice, in the same request as Q12 when sketches are built, alone otherwise | **measured** (`grammar-synthesis.md` Appendix A): "Which kind of edit turns `buggy_line` into the correct line for the `<<<FIX THIS LINE>>>` marker in `program`, so that every entry of `tests` passes? Judge the edit that would be written. Answer carefully and literally." | options `substitute_one_token`, `insert_fragment`, `delete_fragment`, `reorder_tokens`, `reshape_line`, `insert_new_line`, each with definition + two examples; + escape | – | **soft prior only** (`subgoal.ts orderSources`): `insert_new_line` ≥ 0.5 → templates/donors first and insert sites first; `reshape_line`/`reorder_tokens` → permutation operators first; never removes a source | top-1 28–29/40, top-2 35–36/40 over three runs; kind Choices are 53–75 % elsewhere, hence "never a gate" |
| **Q8** `fix` (N ≤ 10) | Choice | **measured** (`probe-selection.md`): "Which option is the corrected line that, put in place of `buggy_line`, makes every test in `tests` pass, including the tests that currently fail? Read each option literally: most options are wrong mutations of the faulty line or copies of other lines. Choose `none_of_these` if no option is a correct fix." (insert sites: "…the missing statement that, inserted immediately after `buggy_line`…") | `{ task, program (function listing), buggy_line_number, buggy_line, tests: [≤ 3, failing first, with actual_with_bug and status_with_bug], candidates? }`; keys `cand_xx`, description = candidate text; **unchanged line never an option**; duplicates folded | escape description "No option is a correct fix; every option leaves the tests failing or breaks the function." | `rank/`: ranked list; `fixProbablyAbsent = P(escape) − p_max ≥ 0.10` | top-1 36/40 at N = 10; unchanged line removed → 20/20 test-passing top picks, 0 confident misses (`probe-question-design.md`) |
| **Q9** `is_fix_<xx>` | Noul per candidate: 11 ≤ N ≤ 60 together with Q8; 61–150 **full criteria** per Noul; 151–254 compact (criteria once in `state.correct_fix_criteria`); > 254 compact in parallel chunks of 254 (150 on repository states) | **measured**: "Is `candidates.cand_<xx>` the corrected line: put in place of `buggy_line`, does it make every test in `tests` pass?" | candidates in `state.candidates` | true "The candidate repairs the exact mistake so the function returns `expected` for every test input, including the tests that currently fail, and stays correct on the tests that already pass." (+ ex.); false "The candidate leaves the bug in place, introduces a different bug, or changes something unrelated to the failure." (+ ex.) | queue order by p; `fixProbablyAbsent = max p < 0.5`; K per §2.4 | full-criteria top-3 40/40/39/39, compact 40/40/38/36 at N = 10/50/150/254; compact 18k tokens, $0.00077, 331 ms; full 57k tokens, $0.0024 |
| **Q10** `fix` (shortlist) | Choice over the Noul top-5 | Q8 wording | after chunked Q9 | as Q8 | final order = Choice P, Noul p breaks ties; escape ≥ 0.5 → "none shortlisted" routing | two-stage 33/40 top-1, fix shortlisted 39/40, ≈ $0.0025, ≈ 0.8 s |
| **Q10r** re-ask | Q9 over the shortlist (≤ 10), shuffled | as Q9 | only when `t_run > 20 s` and the top-2 margin < 0.10 | as Q9 | average the two p's before spending a run | reshuffle moved `kth` 0.48 → 0.14 (`lit-search-based-repair.md` verification) |
| **Q11** `hole_<k>` | Choice per identifier hole, one hole per request | **measured** (`probe-donor-and-templates.md` §2): "Which identifier, in scope in `program`, fills `__HOLE__` in `replacement_templates.hole_<k>` so that the completed line at `program.L<n>` makes all `tests` pass?" | in-scope identifiers ∪ 22 builtins, keys `ident_<name>`; callables only for call-target holes; ≤ 45 + escape | – | `donor/holes.ts`: top-2 fillings enter the candidate set | changed-identifier holes 13/13 (P p50 0.98); same-family pairs (`i`/`j`) permuted in code |
| **Q12** `sketch` | Choice over ≤ 254 sketches | **measured** (Appendix A): "Each option is a sketch of the corrected line for the `<<<FIX THIS LINE>>>` marker in `program`. In a sketch, `_` stands for one identifier, number, string or True/False/None still to be chosen, `<op>` stands for one operator still to be chosen, and every other token is shown literally. Which sketch is the shape of the correct replacement line, so that with the right tokens in its holes every entry of `tests` passes? Read the sketches literally and compare them with `buggy_line`. Choose `none_of_these` if no listed sketch fits the correct line." | `{ task, program (site marked), buggy_line (null at insert sites), tests }`; options `sketch_aa…` with description `{ shape, change }`; pool from productions P1–P13 (§3), the unchanged line's 0-hole shape excluded | – | `sketch/`: keep top-K, K = 3, or 5 when P(top) < 0.5 or P(escape) ≥ 0.3; reorder so the top-2 Q7 classes come first | coverage 39/40, top-1 23–26, top-3 29–31, top-5 32–33; 27 programs with P(top) ≥ 0.5 → top-3 25/27, 13 below → 4/13; $0.00019, 238 ms |
| **Q13** `slot_<hyp>` | Choice per hole, B beam items per request as independent questions | **measured** (`lit-guided-synthesis.md` §5.1): "`hypotheses.first` is a partially written replacement for `buggy_line` in `program`. Tokens before `<HOLE>` are fixed; each `?` is a token still to be filled in later. Which option is the correct token for `<HOLE>`, so that the finished line makes every entry of `tests` pass? Pick `none_of_these` if no option fits." | options = identifiers with roles (≤ 60) / receiver attributes (≤ 40) / 24 operators / literals from tests and file (≤ 30), keys `name_<id>`, `op_plus`, `num_2`, `attr_append` | – | `fill/beam.ts`: expand 1 when p(top) ≥ 0.9 else B = 3; compile-check partials; complete lines re-ranked by Q9 then tested | slots 90–93 % top-1; S2 diff-fill 23/25 (92 %) at B = 3; S1 full-fill 22/29 (76 %) |
| **Q14** `next_token` | Choice, W beams per request | **measured** (`probe-token-synthesis.md`): "`partial_line` is the beginning of the correct replacement line for the `<<<FIX THIS LINE>>>` marker in `program` (its tokens so far, left to right, are `partial_tokens`). Which single Python token comes immediately next in the correct line? Choose `end_of_line` if `partial_line` is already the complete correct line. Choose `none_of_these` if the next token is not offered. Answer literally: exactly one token, not a whole expression." | grammar-legal next tokens (~60 after the filter) + `end_of_line` | – | `beam/`: W = 3, ≤ 25 tokens, top-3 distinct completions become candidates | 84 % / 96 % teacher-forced; W=3+grammar 20/40 any-of-top-3 passes at $0.0037 and 3.3 s per line |
| **Q15** `genuine_fix` | Choice over plausible representatives (≤ 20) | **measured** (`experiments/contrarian/arbitrate.mts`): "Every option makes all tests pass. Which option is the genuine fix of the defect: the replacement that makes `program` correct for every valid input, not only for `tests`? Read each option literally. Answer carefully and literally." | `{ task, program, tests, buggy_program_failure: { input, expected, actual }, candidates: { cand_xx: { line, replaces, with } } }`; + escape | – | `guard.ts`: argmax proposed; runner-up kept as fallback; `P(escape) ≥ 0.9 ∧ max Q16 < 0.1` → `suspect` (§2.6) | true-line sets 8/10 gold, 10/10 gold-or-equivalent; cross-line 10/14 / 13/14; all-overfit set escape 0.90; $0.0001, 189–219 ms |
| **Q16** `general_<xx>` | Noul per arbitrated candidate, same request | **measured** (`experiments/contrarian/arbitrate.mts`): "Is `candidates.cand_<xx>` a correct general fix: with this replacement, does `program` compute the right result for every valid input, not just for the listed `tests`?" (state task text: "Every entry of `candidates` is a replacement … that makes ALL of the program's tests pass. At most one of them is the genuine fix that is correct for every valid input; the others only satisfy the tests. It is possible that none is a genuine fix …") | same request | true "The replacement repairs the actual defect; the algorithm is now correct in general and the change is the minimal one a maintainer would write." (+3 ex.); false "The replacement makes the listed tests pass by coincidence: it special-cases the tested inputs, changes an unrelated part of the line, removes functionality the tests do not exercise, or is a boundary the tests cannot distinguish." (+3 ex.) | override rule (argmax < 0.3 and another ≥ 0.7); informational otherwise; **never** a rejection rule for a lone passer | gold Noul 0.15–0.96 (below 0.7 on 4/10, below 0.3 on 1/10), hence advisory |
| **Q17** `program_correct`, `made_progress`, `broke_something` + Score `closeness` | 3 Nouls + 5-level Score, one request, **consistency check only**, asked on commits and held partials | **measured** (`probe-progress-judgment.md`, verbatim in `src/synth/verify/questions.ts`) | `both` state: counts + `newly_passing_tests` / `newly_failing_tests` + failure texts | as implemented | a confident (≤ 0.3 / ≥ 0.7) disagreement with the code verdict is logged as a `synth` event; ≥ 3 in a run flags the runner parser; `closeness` E[level] orders two bases whose pass counts tie | 240/240 on all three Nouls; Score argmax = bin 230/240; $0.00007 |

Not asked anywhere: "how many", "which is longer", a free next-move policy Choice (Jev misread 1/7 → 2/7 as
"did not help" on 6/10 partials), "is the fix in this set" when tests can answer it, and any Noul threshold
that withholds a test-passing patch.

---

## 3. Candidate sources in priority order

All sources are code, deterministic, compile-filtered, deduplicated across sites, with the unchanged line
removed, `def` lines never mutated, `mem.tried` excluded, and the free vocabulary pre-check applied
(a candidate whose NAME tokens are not in file ∪ tests ∪ issue-text vocabulary is dropped; 100 % of QuixBugs
and 72 % of SWE fixed lines pass it, `coverage-study.md` design 6). Order is the default before the Q7 prior.

| # | Source (module) | What it enumerates at a site | Cap / typical size | Coverage evidence | Ranking / selection evidence |
| --- | --- | --- | --- | --- | --- |
| 1 | **mutation, depth 1** (`src/synth/mutate`, 27–30 operators) | relational/arith/bool/aug swaps, off-by-one (literal and atom), index/slice flips, argument/operand swap, negation, `is`↔`==`, constant ↔ identifier ↔ literal (pool = file + failing-test literals), identifier substitution **restricted to the enclosing function's names first** (median 9 QuixBugs, 116 repo-wide SWE), attribute substitution, builtin swap, return tweaks, wrap `max`/`min`/`abs`/`list`, drop/prepend term, guard conjunct/disjunct, `** 2`, `qualify_name`, `comp_filter`, `boundary_shift` | 254 per site per chunk; QuixBugs median 225 per line (61 % ≤ 255), SWE median 1,641 (3 % ≤ 255) | QuixBugs modified lines 34/36 d1, 36/36 d ≤ 2; gold first-order 38/40 in the probe library; SWE 33/78 modified lines (19 by `qualify_name`) | sieve: gold passes 35/36 when run; Nouls top-3 36–40/40 |
| 2 | **fix templates** (`src/synth/templates`, 8 families) | guard insertion (`if C: return/raise/continue`, copying a sibling's raise), guard extension, missing import (verbatim from the repo, stdlib table), attribute/callee change with the name in scope, add parameter with default + keyword at call sites (composite `extraEdits`), wrap value in a call, `elif`/`else` branch cloning a sibling, insert `x.append(y)` / `x.add(y)` / `y = x` / `return x` / `x += 1` over in-scope names | ≤ 60 per family; insertion pools 295–682 compilable statements per gap | QuixBugs insertions 4/4 (`insert_method_call_scope` ×3, `insert_assign_scope`); SWE templates fire on 16/106 hunks and are the **only** source for `guard_insertion` (2), `add_parameter_default` (2), `add_branch_copy` (1) | insert-mode Nouls put the gold statement top-1 at N = 254 for all four (0.77 / 0.59 / 0.33 / 0.35), two at p ≈ 0.35 → K = 5 at insert sites |
| 3 | **donor lines** (`src/synth/donor`) | same-shape lines of the function → file → repo with ≤ 2 identifiers rebound (each substituted name must occur in the file or the failing test); near-duplicates (Jaccard ≥ 0.5) with one substitution; statement donors with `extraEdits`; holes beyond what code binds filled by Q11 (top-2) | ≤ 100 per site | SWE: donor + ≤ 1 sub 82/199 fixed lines, ≤ 2 subs 109/199, shape 139/199; 58 % of the 121 SWE insertions are a repo line with ≤ 2 subs (**the priority SWE source**); QuixBugs 13/40 lines, ladder `units` (sibling body), `tagcloud` (import) | donor Choice 35/36 own-program, 32/36 at 254; "buggy line back" = no-donor sentinel 35/36 |
| 4 | **composite** (`search/composite.ts`) | depth-2 pairs of the top-10 single edits at one site (`SECOND_ORDER_LIMIT` 100); signature + body + caller as one unit across files (`table`); three-line donor bodies as one unit (`units`) | ≤ 100 pairs; a handful of units | `mergesort` (`== 0` → `<= 1`; `boundary_shift` makes it first-order) and `shortest_paths` need depth 2; `table` needs the coupled unit (h2 or h3 alone break 6 tests, ladder README) | **unmeasured** at this size (§9 R3) |
| 5 | **sketch productions** (`sketch/`, P1–P13) → slot fill (`fill/`) | holed shapes of the site line: one token → `_`/`<op>`, operator+operand, fragment after/before a value (`<op> _`, `[_:]`, `or not _`, `_ is None or`), wrap span `_(span)`, deletions, swaps, expression → hole, RHS templates, insertion statement templates `_._(_)`, `_ = _`, two-line guard, donor shapes | median 64, max 138 sketches per site; K × B ≤ 15 complete lines | shapes cover 39/40 QuixBugs gold lines incl. all 4 insertions (top-1 at P 0.75–0.92); P12 two-line guard covers SWE `pylint-4970`, `requests-2931` | Q12 top-3 29–31/40; S2 fill 92 %, S1 76 % at B = 3; the misses are one-token-deep additive fixes the concrete route already handles |
| 6 | **token beam** (`src/synth/beam`, W = 3 + grammar) | new line at the site or gap, ≤ 25 tokens | ≤ 48 requests per site (`DEFAULT_MAX_REQUESTS`) | 20/40 lines (any of top-3 passes); portfolio 27–28/40; fails on additive fixes and lines ≥ 14 tokens | last resort, only after sources 1–5 report absent |
| – | **test-derived values** (`EnumerateOptions.testLiterals`) | literals from `expected`, its type, length, exception names | – | file + tests vocabulary covers 100 % QuixBugs / 72 % SWE lines vs 68 % file-only | feeds 1, 2, 5; not a source of its own |
| – | **task-text names** (SWE, `EnumerateOptions.taskIdentifiers`) | identifiers and quoted words in `problem_statement` / `hints_text` added to the slot vocabulary and the substitution pool | tens | 5 of 21 SWE template matches fail only because a slot name is absent from file + tests (`exclude`, `metavar`, `saferepr`) | **unmeasured** as a source (§9 R5) |
| – | **history** (`git log -S`) | past hunks touching the function | – | not measured | not in v1 |

Reordering by Q7 (soft): `insert_new_line` ≥ 0.5 → 2, 3, 1, 4 and insert sites first; `reorder_tokens` /
`reshape_line` → 1 with permutation operators first, then 4; nothing is ever skipped, the prior only decides
which source spends the budget first.

---

## 4. Verification and budgets

### 4.1 The oracle model (code, measured on the baseline run)

```
OracleModel = { runner: 'quixbugs' | 'pytest' | 'other', lanes: L, tRunMs: { goalSubset, fullSuite }, perTestTimeoutMs, baselineDurationMs }
perTestTimeoutMs (QuixBugs runner) = clamp(3 × baseline per-test p50, 500 ms, 2,000 ms)     # 0.5 s rejected no gold on 35/35 (`contrarian-exhaustive.all.jsonl`)
runTimeoutMs (pytest)               = min(limits.commandTimeoutMs, 3 × baselineDurationMs + 10 s, wallRemaining)
lanes                                = 8 on QuixBugs-class suites (t_run < 1 s), 4 on pytest modules, 2 when the workspace is > 50 MB and not git
```

A timed-out candidate run is a failing test with `actual = "Timeout: the program did not finish within N seconds
(probable infinite loop)"` (Jev used this correctly for `bitcount`, `sqrt`, `breadth_first_search`), counts as a
regression for routing (`RUN_FAILURE_ID`), and is never held as a base. A timed-out **baseline** parks the run's
goals with reason `suite too slow` and proposes a `run` of the full command so the engine's judge sees it.

### 4.2 Where candidates run: shadow lanes, never the workspace

The synthesizer never writes into the real workspace; the engine's execute stage applies the returned `patch`.
Lanes live under `<workspace>/.jevcode-synth/<runId>/lane<k>/` (inside the sandbox's writable root, added to
`.git/info/exclude`; the requested contract change `SynthesisContext.runDir` moves them beside the checkpoints):

- **QuixBugs runner**: no copy at all; the candidate file is written to `lane<k>/<name>.py` and passed as
  `candidatePath` to `run_tests.py <name> <candidatePath>` with `PYTHONDONTWRITEBYTECODE=1` (the stale-`.pyc`
  pitfall of `probe-question-design.md` §8).
- **git workspaces (ladder, SWE)**: `git worktree add --detach lane<k> HEAD` once per run, reset with
  `git checkout -- . && git clean -fdq` between candidates, diff applied with `git apply`; the venv is the
  workspace's (`.venv/bin` on PATH, DESIGN §8).
- **non-git**: `cp -R` of the touched package (≤ 50 MB), else sequential apply/revert in the workspace with the
  revert in `finally`. (`cp -al` is not used: BSD `cp` has no `-l`.)

All runs go through `ctx.sandbox.run(command, { cwd: lane, timeoutMs, signal })`. Jev requests for the next
site/source are issued while the current batch runs (the loop is test-bound; Jev is ~240 ms).

### 4.3 Runs and requests per step (all code, counted in `StepBudget`)

| Run | When | Scope | Count per step |
| --- | --- | --- | --- |
| baseline | first step, after every commit, on resume | full suite | 1 |
| goal-subset candidate runs | every queued candidate | the goal's failing tests + the passing tests in the same file (`pytest <file>::<test>` ids; `run_tests.py` runs its whole JSON suite anyway) | SIEVE: `floor(testWallLeft × lanes / t_run)`; RANK: K per site (3, or 5) × ≤ 4 sites per source → ≤ 12 |
| full-suite regression | every goal-subset passer, before it can be `plausible` | whole detected suite | ≤ 5 (stop after the fifth passer) |
| behaviour clustering | ≥ 2 plausible | generated inputs, all passers, one batch | ≤ 1 |
| pairs of partials | after SEEDS when two partials from different sites fix disjoint subsets | goal subset | ≤ 10 |

Per-step caps: **QuixBugs-class** (t_run < 2 s): `testWall ≤ min(90 s, wallRemaining / 4)`, `testRuns ≤ 1,500`,
`jevRequests ≤ 30`; **repository-class**: `testWall ≤ min(8 × baselineDuration, 600 s)`, `testRuns ≤ 16`
(12 subset + 3 full + 1 baseline), `jevRequests ≤ 60` (SWE chunked ranking is ≈ 11 chunks × ≤ 5 anchors, so
the cap binds at ~2 anchors per step and the rest carry over). A step that hits a cap returns a goal-subset
`run` (one cheap outer step) and resumes from memory. Basis: every prototype failure stopped on the 40-run cap
while using ≤ 14 of 30 requests; the sieve makes the QuixBugs run cap irrelevant (median 3.8 s per true-line
set) while the SWE caps keep a step at 3–20 min of pytest.

### 4.4 Progress arithmetic and acceptance (code)

`progress()` and `route()` in `src/synth/verify/progress.ts`: `allPass`, `improved = after.passed > before.passed`,
`regressed = newlyFailing > 0 || after.passed < before.passed`; `REGRESSION_RULE` = revert on any regression,
including when the newly failing test is the attacked one. A partial (`improved && !regressed`) is **held**,
not committed: `bases.improved` (≤ 1, replaced only by strictly more `passed`, ties by `closeness` E[level]);
the current phase's queue is finished first; the improved base is committed only when every source is
exhausted for the goal (its full-suite run showed no regression by construction), after which the goal is
re-clustered from the new baseline and searched again next step. This keeps the three genuine two-step
repairs (`find_first_in_sorted`, `minimum_spanning_tree`, `sieve`) reachable without the greedy trap, and the
sieve removes the trap's cause on QuixBugs (the whole set runs, so `kth`'s `k - 1` false lead and the gold are
seen together).

### 4.5 Cost and latency per step, from the measurements

Constants: Jev $0.042 per million input tokens, p50 176–331 ms by state size, 128-way concurrency; QuixBugs run
87–395 ms p50 on non-looping lines; ladder suites 0.11–0.12 s; SWE F2P-only pytest 3–20 s, django module
30–120 s.

| Stage | Requests | Cost, QuixBugs-sized state | Cost, SWE-sized | Wall |
| --- | --- | --- | --- | --- |
| Q1 (skipped with one goal) | 0–1 | $0.00006 | $0.0005 | 0.2 s |
| Q2–Q3 repo file beam (once per run, cached) | 0–5 | – | $0.0013 | 0.3 s × ≤ 4 concurrent |
| Q4 functions (per beam file, per goal) | 0–5 | – | $0.0005 | 0.25 s |
| Q5 (+Q5n) lines | 1–5 | $0.00016 (D + C in one request) | $0.0002 each | 0.2 s |
| Q7 (+Q12) | 0–1 | $0.00019 | $0.0008 | 0.25 s |
| Q8–Q10 ranking (RANK mode only) | 0 on QuixBugs sieve steps; 1–3 per site otherwise | $0.00005–0.0014 | $0.0008 per 254-chunk; ≈ 7 chunks ≈ $0.005 per anchor | 0.2–0.35 s, chunks concurrent |
| Q11 holes | 0–3 | $0.00006 each | $0.0005 each | 0.2 s |
| Q13 slot fill (SKETCH phase) | 2–12 | $0.0002–0.0007 | $0.001–0.004 | 0.4–1.3 s |
| Q14 token beam (BEAM phase) | ≤ 31 per line | $0.0037 | ≈ $0.02 | 3.3 s |
| Q15 + Q16 (≥ 2 plausible only) | 0–1 | $0.0001 | $0.0006 | 0.2 s |
| Q17 consistency (per commit / held partial) | 0–1 | $0.00007 | $0.0001 | 0.2 s |
| **Typical QuixBugs step (SEEDS sieve at ≤ 3 sites)** | **1–3** | **≈ $0.0002–0.0005** | – | Jev < 1 s; tests ≈ 4–15 s (3 sites × median 3.8 s / lanes overlap) |
| **WIDENED step (single file)** | 0–1 | ≈ $0.0001 | – | median 24 s, max 119 s at 12-way |
| **Typical SWE step** | **15–40** | – | **$0.01–0.04** | Jev 3–6 s; tests 3–20 min |

Whole task: QuixBugs 2–4 steps (`patch → run`, sometimes `run(budget) → patch → run`), ≤ $0.003 Jev, ≤ 30 s
typical and ≤ 150 s worst (a WIDENED step on `mergesort`); ladder 3–8 steps, ≤ $0.03; SWE ≤ 40 steps, ≤ $0.5
Jev, wall dominated by pytest. Engine overhead per step (intent, context, risk, judge) is 3–4 requests ≈ $0.0003.

---

## 5. Integration with the existing engine

### 5.1 What one step is, and what comes back

`Synthesizer.synthesize(ctx: SynthesisContext) → Promise<Proposal>` (`src/core/types.ts`). One call = one
Proposal; internally it may spend dozens of requests and hundreds of test runs, all through `ctx.ask` and
`ctx.sandbox`. It returns exactly one of:

| Situation | `Proposal.action` | `goal` text | `plan` draft |
| --- | --- | --- | --- |
| a candidate committed for goal g | `{ kind: 'patch', diff }` (unified diff over the touched files from `applyCandidate`, `extraEdits` included, ≤ 2 files) | `fix <tests of g> in <path>:<line> (<source>/<op>)` | `done: []` (nothing claimed yet); `remaining`: one fixed-form item per open/parked goal; `openProblems`: human-readable notes only (parked reasons, `possible overfit: …`, `fix-absent at <site>`) |
| the previous executed action was a `patch` | `{ kind: 'run', command: <full test command>, timeoutMs }` | `verify the suite after fixing <tests>` | `done: ['fix <tests> in <path>']` **claimed now**, so the engine's `done_<j>` Noul judges it on this step's parsed test output (DESIGN §6 Plan rule a) |
| step budget hit mid-search | `{ kind: 'run', command: <goal-subset command> }` | `record the failing behaviour of <tests>` | unchanged; the search resumes from memory next step |
| baseline green | `{ kind: 'done', summary: 'all <n> tests pass; <k> fixes committed' }` | – | `remaining: []` |
| every goal parked | `{ kind: 'done', summary: 'partial: fixed <k> of <n> failing tests; <reasons>' }` | honest partial | `remaining`: the parked items; reasons in `openProblems` |
| directive `gather_context` (repo) | `{ kind: 'read', paths }` for the goal's suspected files not in `contextFiles` | – | unchanged |
| directive `revert_changes` | reverse `patch` of the last committed candidate | `revert <op> at <path>:<line>` | the goal returns to `remaining` |

`edit` and `write` are never proposed (a `patch` carries multi-line `extraEdits` atomically and the engine runs
`git apply --check`); `run` is only ever the test command or a goal-subset of it.

The `run` after every `patch` is deliberate: it is how `workspace.lastTestRun`, `testsCurrent` and the
`task_complete` Noul (whose true criteria require `lastTestRun.allPassed && testsCurrent`, DESIGN §5.5) see the
oracle, and it is the evidence the `done_<j>` Noul needs. A successful QuixBugs program is therefore
`patch → run` (completion fires on the `run` step at `task_complete ≥ 0.85`) or `patch → run → done`.

### 5.2 Plan and progress tracking

`plan.remaining` items use the fixed grammar `fix <first_test_id>[, +N more] in <path>` so they are (a) readable
by the engine's Jev stages (intent `plan_still_valid`, risk `plan_mismatch`, completion) and (b) parseable back
into goals on resume (`memory.ts parseGoalItem`). The ledger is emitted every step as a `synth` event
(`{ phase: 'ledger', detail: 'fixed 2, open 1, parked 1' }`) and the `SearchTrace` records sites, candidates
enumerated/ranked/tested, requests, runs and outcome per step. The completion Noul is the engine's; the
synthesizer never asks it. Machine state is **not** put in `openProblems` (contrarian's grammar line is
Jev-visible to the risk stage's `plan_mismatch` level 3 and unmeasured); a `CheckpointState.synthState?: Json`
hook is requested as a follow-up contract change for `tried` and `widenCursor` (v1 works without: lost state
costs test time, never a wrong commit).

### 5.3 Loops and stuck detection

Internal (code): a goal is parked when every source is exhausted at every site (including WIDENED on single
files), or after 3 searches without a commit, or after 2 consecutive budget-hit steps, or when the vocabulary
pre-check says the fix needs an unavailable name and sources 1–3 are exhausted. A parked goal is re-opened only
when a later commit changes one of its suspected files (attempts kept). `mem.tried` makes every proposed
`patch` unique, so the engine's `patch:<sha12>` signature cannot reach 3; `run:<cmd>:<result>` can reach 3 only
via three identical budget-hit subset runs, which the 2-budget-hit park rule prevents; `done:<sha12>` reaches 3
only on three blocked partial `done`s, which is the intended exit (§5.5). A `patch` whose outcome was `failed`
(did not apply) invalidates the goal's `localizeCache` and re-localises from the re-read file.

External: `max_steps` (40), `max_replans` (5), spend cap and wall time apply unchanged.

### 5.4 Replan directives (`ctx.directive`)

`change_approach` → rotate the active goal's source order (exhausted set kept), widen the site beam 6 → 10,
and on repositories enable WIDENED over the beam functions; `gather_context` → `read` of the goal's suspected
files (repo) or re-localise with the latest failure text and a top-10 file beam; `fix_environment` → a `run` of
the test command alone (the synthesizer installs nothing; the outcome tells the judge whether the environment
works); `revert_changes` → reverse patch of the last commit; `stop_and_report` is handled by the engine
(`replan_stop`).

### 5.5 What `done` means

`done` is proposed only when (1) the last full-suite run on the committed workspace has `failed == errors == 0`,
`passed > 0`, no timeout, and was **executed by the engine** (a `run` step in `ctx.window` with parsed counts),
(2) no file under the tests directory was changed by any committed candidate (code check on the diffs), and
(3) the guard path of §2.6 has run where it applies. The engine's `task_complete` Noul remains the stop rule. A
partial `done` that the risk stage blocks (`plan_mismatch` with `remaining` non-empty) is proposed at most
twice; the third repetition trips `done:<sha12>` and the replan stage's `task_impossible` / `stop_and_report`
ends the run, which is the correct outcome for an exhausted search.

### 5.6 The `jev-only` bench condition: assertions

Already in the engine and bench (DESIGN §21, `src/bench/conditions.ts`, `src/bench/runner.ts`): the generator
slot holds a `NullProvider` that throws if `generate()` is reached; `engine.ts` throws
`jev-only mode: the generating LLM must not be called` before any provider call; the bench records
`generatorCalls = RunResult.usage.generator.calls` per run and writes any jev-only record with a non-zero count
as `pass: null, evaluator: 'invalid', reason: 'generator called in jev-only'`; `summary.json` reports
`generator calls (jev-only asserts 0)`. This design adds, in the synthesizer and the `quixbugs` / `ladder` /
`swebench` suites: every Jev request the synthesizer makes goes through `ctx.ask('propose', …)` (asserted by a
unit test that a synthesizer built with a throwing raw decider still works); no `edit` / `write` proposals
(asserted per record); `tests/` unchanged (`git diff --quiet -- tests/` in the evaluator); `SearchTrace` totals
(`jevRequests`, `testRuns`, `candidatesTested`, `bySource`) written per record so cost and CPU are auditable;
the `synth` event stream contains a `ledger` line per step.

---

## 6. Modules and shared types (sized for 6–8 engineers in parallel)

Existing and reused as is (unit-tested, measurement-cited in their headers): `src/synth/py/`, `mutate/`,
`templates/`, `donor/`, `beam/`, `localize/`, `rank/`, `verify/`, `sbfl/`, `types.ts`. Two small changes to
existing files: `localize/sites.ts` gains insert gaps as first-class `Site`s before/after each anchor and an
`sbflAnchors` option (5 single-file / 3 repo); `rank/index.ts` gains chunk size 150 when the function listing
exceeds ~4k tokens and `shuffleRerank(shortlist)`.

New files. Engineer letters are a suggested split; A owns the contract and the integration test, everyone else
codes against the types below from day one.

| File | Responsibility | Jev questions | Key exports | Eng. |
| --- | --- | --- | --- | --- |
| `src/synth/search/index.ts` | `createSynthesizer(opts): Synthesizer` wiring §2.2; replaces the placeholder in `src/synth/index.ts`; `synth` events; `SearchTrace` per step | – | `createSynthesizer`, `LedgerSieveSynthesizer` | A |
| `src/synth/search/memory.ts` | `SearchMemory` per run; rebuild from `plan.remaining` + baseline on resume; `tried`; fixed-form plan items | – | `getMemory(runId)`, `rebuildFromPlan`, `planItemFor(goal)`, `parseGoalItem` | B |
| `src/synth/search/goals.ts` | cluster failing tests into goals from tracebacks (file, function, ±3 lines) / SBFL / one per test; status transitions; parking and re-open rules | Q1 via `verify.pickNextFailingTest` with goal-level options | `clusterFailures`, `reconcile`, `pickGoal`, `park`, `reopenOnChange` | B |
| `src/synth/search/subgoal.ts` | §2.3 controller: phases × bases × sites × sources, Q7 prior, `decideRunPlan`, fix-absent skip, commit/hold/park/budget | Q7 (+Q12 request shared with `sketch/`), Q8–Q10 via `rank/`, Q11 via `donor/` | `searchSubGoal`, `orderSources`, `decideRunPlan`, `EDIT_CLASSES` | A |
| `src/synth/search/budget.ts` | `StepBudget`, `OracleModel` fitting from the baseline run, adaptive timeouts, lane count, `SIEVE_MAX_T_RUN_MS` | – | `fitOracle`, `freshBudget`, `runTimeout`, `perTestTimeout` | C |
| `src/synth/sieve/lanes.ts` | shadow lanes (§4.2): QuixBugs candidatePath fast path, `git worktree` pool, `cp -R` fallback; apply, reset, dispose; all through `ctx.sandbox.run({ cwd })` | – | `createLanes(L)`, `withLane`, `applyToLane`, `disposeLanes` | C |
| `src/synth/sieve/runner.ts` | parallel batch verification on the lanes; goal-subset command builders (pytest node ids / `run_tests.py`); timeouts; `Progress` per candidate via `verify.progress`; kill on step deadline / `ctx.signal` | – | `runQueue`, `subsetCommand`, `fullSuiteCommand` | C |
| `src/synth/sieve/queue.ts` | global verification queue keyed by (base passed desc, p desc, source prior desc); dedupe by normalised text; unchanged-line removal; vocabulary pre-check; `tried` exclusion; carry-over across steps | – | `VerifyQueue`, `vocabularyOf`, `passesVocab` | D |
| `src/synth/search/guard.ts` | §2.6: perturbed-input generation, behaviour clustering, Q15 + Q16 request, suspect rule, Choice/Noul override, fallbacks | Q15, Q16 | `clusterByBehaviour`, `perturbedInputs`, `arbitrate`, `decide` | E |
| `src/synth/search/bases.ts` | beam of bases (≤ 2), replacement rule, `closeness` tie-break (Q17), partial commit at exhaustion, pairs of partials across sites (≤ 10 runs) | Q17 via `verify.judgeProgress` (consistency) | `holdBestPartial`, `pairsOfPartials`, `commitPartial` | E |
| `src/synth/search/sites.ts` | §2.5 site list: Q5 ∪ Q5n ∪ SBFL union, insert gaps, Q6 gaps, trace-tail gap, `def` exclusion, cut 6 + 6, WIDENED all-lines enumeration with cursor | Q6 via `localize/` | `buildGoalSites`, `widenedSites`, `nextWidenChunk` | F |
| `src/synth/search/composite.ts` | source 4: depth-2 pairs at one site, signature + call-site unit, multi-line donor body unit (as a `CandidateSource` with `extraEdits`) | – | `createCompositeSource` | F |
| `src/synth/sketch/productions.ts`, `pool.ts`, `questions.ts` | P1–P13 over `Tok[]` with grammar preconditions; ordering, dedupe, 254 cap, unchanged-shape exclusion; Q12 + Q7 state and wording; K rule | Q12, Q7 | `sketchPool`, `instantiates`, `sketchQuestions`, `keepK` | G |
| `src/synth/fill/beam.ts`, `state.ts` | slot beam over holed hypotheses: prefix-mode Q13 for K × B items per request, expand-1 at p ≥ 0.9, compile gate, same-class permutation in code; complete lines with Σ log p (ordering only) | Q13 | `fillSketches`, `slotQuestion` | G |
| `src/synth/search/proposal.ts` | Proposal builders (`patch`, `run` full / subset, `done` green / partial, `read`); plan draft in the fixed grammar; `openProblems` notes; `rawText` = `SearchTrace` JSON | – | `proposePatch`, `proposeRun`, `proposeDone`, `proposeRead` | H |
| `src/synth/search/directive.ts` | §5.4 mapping of replan directives; stale-site detection from a failed `patch` in `ctx.window` | – | `handleDirective`, `patchFailedLastStep` | H |
| `test/unit/synth/search/*.test.ts` | goal clustering from pytest tracebacks and `run_tests.py` JSON; `decideRunPlan` arithmetic; queue ordering; lanes with a fake sandbox; guard on synthetic outputs (the 7 `depth_first_search` overfits, the `next_permutation` equivalents); plan-item round trip; directives; a mocked end-to-end on `bench/data/ladder/tasks/inventory` with a scripted decider | – | – | all |
| `test/live/synth-search.live.test.ts` | `gcd` (sieve, one plausible), `next_permutation` (arbitration), `wrap` (insert site) against live Jev with the QuixBugs runner (≤ $0.01) | – | – | A |

### 6.1 Shared types (add to `src/synth/types.ts` or `src/synth/search/types.ts`)

```ts
import type { AppliedCandidate, Candidate, CandidateSourceName, LocalizeResult, RankedCandidate, Site, SourceFile, TestRunSummary, FailureView } from '../types.js';

export type GoalStatus = 'open' | 'active' | 'parked' | 'fixed';

export interface Goal {
  id: string;                                  // "g3"
  tests: string[];                             // failing test ids in this cluster
  failures: FailureView[];                     // expected / actual per test (code-computed, bounded)
  suspectedFiles: string[];                    // traceback frames + SBFL, refined by localisation
  status: GoalStatus;
  attempts: number;                            // searches run for this goal
  budgetHits: number;                          // consecutive budget-hit steps (2 → park)
  exhausted: Map<string, Set<CandidateSourceName>>;   // siteKey → sources fully enumerated + run at that site
  phase: 'SEEDS' | 'SKETCH' | 'BEAM' | 'WIDENED';
  parkedReason?: string;
  planItem: string;                            // `fix <first_test_id>[, +N more] in <path>`
}

export interface Base {
  id: string;
  origin: 'committed' | 'improved';
  fromGoal: string | null;
  files: ReadonlyMap<string, SourceFile>;
  summary: TestRunSummary;
  candidate?: AppliedCandidate;                // the edit that produced an 'improved' base
  depth: number;                               // ≤ 3 edits above the committed workspace
}

export interface OracleModel {
  runner: 'quixbugs' | 'pytest' | 'other';
  lanes: number;
  tRunMs: { goalSubset: number; fullSuite: number };
  perTestTimeoutMs: number | null;             // QuixBugs runner only
  runTimeoutMs: number;
  baselineDurationMs: number;
}

export interface StepBudget {
  jevRequestsLeft: number;
  testRunsLeft: number;
  testWallLeftMs: number;
  startedMs: number;
  recursed: boolean;
  exhausted(): boolean;
}

export type RunMode = 'SIEVE' | 'RANK';
export interface RunPlan { mode: RunMode; k: number; runsAllowed: number }

export interface VerifyJob {
  candidate: Candidate;
  base: Base;
  p: number;                                   // Noul/Choice p in RANK mode, source prior in SIEVE mode
  sourcePrior: number;
  key: [number, number, number];               // (base.summary.passed, p, sourcePrior), all descending
}

export interface VerifyOutcome {
  job: VerifyJob;
  applied: AppliedCandidate;
  subset: TestRunSummary;                      // goal-subset run
  full?: TestRunSummary;                       // full-suite regression run, only for subset passers
  progress: import('../types.js').Progress;
  status: 'plausible' | 'partial' | 'regressed' | 'unchanged' | 'timeout' | 'apply_failed';
}

export interface BehaviourCluster { id: string; members: VerifyOutcome[]; representative: VerifyOutcome; signature: string }

export interface Arbitration {
  pick: VerifyOutcome;
  fallbacks: VerifyOutcome[];
  pChoice: Record<string, number>;
  pEscape: number;
  noul: Record<string, number>;
  suspect: boolean;                            // pEscape ≥ 0.9 && max(noul) < 0.1
  requests: number;
}

export type Decision =
  | { kind: 'commit'; applied: AppliedCandidate; allGoalTestsPass: boolean; note?: 'possible overfit' | 'partial' }
  | { kind: 'continue' }
  | { kind: 'budget' }
  | { kind: 'parked'; reason: string };

export interface SketchHypothesis {
  site: Site;
  toks: string[];
  holes: number[];                             // indices into toks; `_` or `<op>`
  production: string;                          // 'P1' … 'P13'
  pSketch: number;
  logP: number;                                // Σ log p over filled slots (ordering only)
  extraEdits?: import('../types.js').LineEdit[];
}

export interface Lane { index: number; dir: string; mode: 'candidate_file' | 'worktree' | 'copy' | 'inplace'; busy: boolean }

export interface GoalSearchTrace extends import('../types.js').SearchTrace {
  goalId: string;
  phase: Goal['phase'];
  runMode: RunMode;
  plausible: number;
  clusters: number;
  arbitrated: boolean;
  tRunMs: number;
}
```

Requested contract changes (not made here; `src/` is out of scope for this document): `SynthesisContext.runDir:
string` (absolute path of the run directory for lanes and traces) and `CheckpointState.synthState?: Json`
(opaque synthesizer state saved and restored with the checkpoint). Both designs that build scratch copies asked
for the first; the second removes the only durability gap in §5.2.

---

## 7. Evaluation plan on the ladder

Run in this order; each rung gates the next. All runs are the bench's `jev-only` condition with the assertions of
§5.6, `--live`, `--spend-cap` per rung, 3 repeats where noted (prototype run-to-run flips: 30 repaired in both
runs, 34 in either).

| Rung | Data | Condition | Measured | Success threshold (proceed) | Fallback if missed |
| --- | --- | --- | --- | --- | --- |
| 1a | QuixBugs 40 (`bench/data/quixbugs`) | 3 repeats, default budgets | repaired (tests), correct by diff vs `correct/`, steps, requests, runs, test CPU, cost, wall; failure class per miss (`fix_not_in_candidates` / `localisation_missed` / `ranking_missed` / `overfit` / `budget`) | ≥ 36/40 repaired in every repeat, ≥ 34 correct by inspection, 0 regressions kept, ≤ $0.01 and ≤ 150 s per program, `ranking_missed` = 0 | if `ranking_missed` > 0: raise `SIEVE_MAX_T_RUN_MS`; if overfit > 1: enable the hidden-test experiment (R2) before rung 2 |
| 1b | the 4 insertion programs + `shortest_paths` | 3 repeats | gap-site enumeration count, gold statement rank, K needed, runs | ≥ 3/4 insertions repaired in ≥ 2 of 3 repeats | ask Q6 per template statement and enumerate only its placement (repair-search R3 fallback) |
| 2 | ladder 12 tasks (`bench/data/ladder`) | 3 repeats | solved (pytest exit 0, `tests/` unchanged), steps, commits, reverts, parks, goals formed vs hunks, Q7 top-1 vs `kinds`, Q1 pick order | ≥ 8/12 in ≥ 2 of 3 repeats; the 5 multi-bug tasks ≥ 4/5; 0 regressions kept | one goal per failing *test* (no clustering) and immediate partial commits (the prototype's behaviour) |
| 3a ($0) | the 9 coverage-reachable SWE instances | `experiments/repair-search/hunk-subsets.py` | minimal subset of gold hunks that passes F2P + P2P | informs the multi-hunk expectation; no gate | – |
| 3b ($0.15) | 33 SWE depth-1 lines + 21 ladder hunks | `rank-at-scale.mts` | gold rank among the real candidate set (function-scope names first), chunk 150 vs 254, 3 shuffles, `fixProbablyAbsent` false alarms | gold ≤ 5 on ≥ 6/9 instances with median max-Noul ≥ 0.5; ≤ 1 false positive at p ≥ 0.5 per wrong site | SimFix-style similarity pre-filter to top-300, or donors + templates only on SWE sites |
| 3c | SWE-bench Verified 30 | live, `--spend-cap 0.50` per instance, mocked first | F2P pass under the local evaluator (unofficial), P2P regressions, steps, cost, wall, `generatorCalls = 0`, failure class (localisation / coverage / ranking / multi-hunk / budget) | any instance resolved is the result; report the taxonomy; 0 of the 15 vocabulary-fail instances by construction | – |

Per-item tables (n ≤ 40) go under `bench/results/<suite>-jev-only-<date>/summary.md`, one row per program or task.

---

## 8. Predicted numbers, each with the measurement it rests on

### 8.1 QuixBugs (40)

| Component | Rate used | Measurement |
| --- | --- | --- |
| true site among the ≤ 12 sites (Q5 top-3 ∪ Q5n top-3 ∪ SBFL top-5 + gaps) | 38/40 lines; `lis`, `mergesort` reached by WIDENED on the next step | `probe-localization.md` §1, §8.2; `lit-search-based-repair.md` §6 (Ochiai 3.0, 5.0) |
| gold passes when run at the true line | 35/36 replacements (`shortest_paths` needs depth 2, in composite) | `contrarian-exhaustive.truth.jsonl` |
| SIEVE fits the step budget at ≤ 3 sites | median 119.5 candidates per line, 3.8 s per program at 8-way; 3 sites ≈ 12 s | same file |
| only one plausible → no decision | 25/36; ≥ 2 plausible → Q15 gold-or-equivalent 10/10 (true line) and 13/14 (cross-line) | `contrarian-arbitrate.*.jsonl` |
| insertions | statement pools 295–682 → RANK mode, Nouls top-1 at N = 254 for all four but two at p ≈ 0.35 → K = 5 → ≈ 3/4 | `probe-selection.md` per-program rows; **end to end unmeasured** (§9 R1) |
| `shortest_paths` | composite depth-2 (pool ≈ 5k lines at 12-way ≈ 3 min → over budget) | `coverage-study.md`; likely a miss |
| overfit | the all-overfit `depth_first_search` set flagged (escape 0.90 / 0.06) and the gap-site gold (`nodesvisited.add(node)`, Noul 0.77) reachable; residual `detect_cycle`-style wrong-line ties 1/40 | `contrarian-arbitrate.all.jsonl` Table 0.4 |
| run-to-run noise | ± 1–2 programs, now confined to the RANK-mode items (insertions) | `prototype-baseline.md` stability |

**Prediction: 37–39/40 test-passing (central 38), 35–37 correct by inspection**, ≤ $0.003 Jev and ≤ 30 s typical /
≤ 150 s worst per program, 2–4 outer steps. Floor 34 (the prototype's 32 plus the two localisation misses that
WIDENED reaches deterministically). Against the field: prototype 32, AlphaRepair 27, ChatGPT-with-hints 31
(`lit-search-based-repair.md` §5).

### 8.2 Ladder (12 tasks, 21 hunks)

| Task | Why reachable (or not) | Expected |
| --- | --- | --- |
| inventory, grades, textstats (2 independent hunks each) | each hunk alone fixes ≥ 1 test (README matrix); all kinds are depth-1 mutations (`rel_swap`, `off_by_one`, `ident_sub`) or an add-keyword template (`reverse=True`); two goals, `patch → run` each; suites 0.11 s → SIEVE mode | 3/3 |
| account, calendar_utils (3 independent hunks) | same; `dst.withdraw` → `dst.deposit` is `attr_sub`; three goals | 2/2 (one mid-band flip possible) |
| profiles, stats (inserted guard) | `guard_insertion` template (the only SWE source for 2 hunks); `stats` copies a sibling's raise (donor 1-sub); gap Choice 4/4 given the statement | 2/2 |
| tagcloud (missing import) | `missing_import` / verbatim donor (SWE import lines exist elsewhere 2/2) | 1/1 |
| shipping (constant 500.0 → 50.0) | `const_sub` with the test-literal pool | 1/1 |
| events (attribute) | `attr_sub`; holes 13/13 | 1/1 |
| table (3 coupled hunks, 2 files) | only the composite signature + call-site unit reaches it; unmeasured | 0–1 |
| units (3-line body from a sibling) | donor ≤ 2-sub per line as one composite unit; unmeasured at 3 lines | 0–1 |

**Prediction: 9–10/12**, 3–8 steps and ≤ $0.03 per task. This is the rung the ledger is for; §9 R3 measures it.

### 8.3 SWE-bench Verified (30)

Two measured gates: coverage (`coverage-study.md`: 9/30 fully reachable under the 2-sub union: `django-15315`,
`-15572`, `-16100`, `-15916`, `pytest-10051`, `pylint-4970`, `-6386`, `requests-1142`, `-2931`) and chained
localisation (`probe-swebench-understanding.md`: file #1 ∧ fn ≤ 5 ∧ line ≤ 5 within ±3 on 21/30; of the nine,
`django-16100` file #2 and `pylint-6386` file #17 fail it, 7 survive). Unmeasured gate: ranking at 1,641
mutants per line (×0.6–0.8 assumed until §9 R4) and multi-hunk decomposition (5 of the 7 need 2–8 hunks;
`hunk-subsets.py` will say how many the tests demand). F2P sizes: 28/30 have 1–3 tests, so the goal-subset run
is affordable everywhere except `pytest-7205` (10) and `pylint-4604` (21).

**Prediction: 3–5/30 pass their FAIL_TO_PASS tests under the local evaluator (central 3–4)**; `django-15315`
(donor 1-sub `return hash(self.creation_counter)`), `pylint-4970` (guard insertion), `django-15572` (two
`comp_filter` mutations, two goals), `requests-2931` and `requests-1142` are the first expected; 0 of the other
21 by construction (new logic, new names, idiom changes), reported as such. The honest ceiling is 9–10/30 until a
name source beyond file + tests + issue text exists. Cost ≈ $0.05–0.25 Jev per instance, 10–60 min mostly pytest.
For comparison the jev-on generator condition solved 9/29 (`docs/STATUS.md`); any solve with no generating model
is the result the brief asks for.

---

## 9. Open risks and the experiment that retires each

| # | Risk | Why it matters | Experiment (script, cost) | Retired if | Otherwise |
| --- | --- | --- | --- | --- | --- |
| **R1** | **Insertions end to end are unmeasured.** The sieve JSONL enumerated 0 gap-site candidates; gap pools are 295–682 statements × ≤ 6 gaps, so they run in RANK mode where the gold statements sit at Noul 0.33–0.39 (`shunting_yard`, `wrap`) and a tie with a wrong statement is one shuffle away; `shunting_yard`'s gap is invisible to SBFL. | 4/40 of the QuixBugs prediction and 121/199 SWE fixed lines are insertions. | `experiments/insert-e2e/insert-e2e.mts`: the 4 insertion programs end to end with gap sites after the top-3 anchors, templates + donors, chunked Nouls, K = 5, 3 seeds; ≈ $0.02. | ≥ 3/4 repaired with the gold statement in ≥ 2 of 3 seeds. | ask Q6 with each template statement and enumerate only its placement; or SIEVE the gap pool at the single best gap when `t_run` allows (500 × 0.22 s / 8 ≈ 14 s). |
| **R2** | **Exhaustive verification manufactures plausible-but-wrong patches.** The sieve surfaces every passer (6/40 programs have passers on ≥ 2 lines in the brute-force run); the guard is measured on 24 sets only; Ye et al. report 53 % overfitting among plausible QuixBugs-Java patches. | Sets the correct-by-inspection rate, and a wrong commit can make the next goal unreachable. | `experiments/contrarian/hidden-tests.mts`: hold out half of each JSON suite (and the `slow` cases) as hidden tests; run the sieve + guard on the visible half; count plausible-on-visible that fail hidden, and how often the clustered + arbitrated pick passes hidden, vs min-edit and vs "propose the first passer"; n = 31, ≈ $0.02. | guard's hidden-pass rate ≥ min-edit + 10 points and the accepted set's overfit rate ≤ 5 %. | generated differential inputs (EvoSuite-style) become part of the goal subset before a commit; the Noul guard stays advisory. |
| **R3** | **The decomposition itself: goal clustering by traceback frame, coupled edits, the beam of bases.** Hunk independence is verified on 5 ladder tasks only; `table` is coupled by construction; clustering and the composite unit are unmeasured. | The rung-2 criterion in `docs/JEV-ONLY.md`. | `experiments/ladder-e2e/`: all 12 ladder tasks in `jev-only`, 3 repeats; per task solved, steps, commits, reverts, parks, goals vs hunks, Q7 vs `kinds`, and for `table` whether the composite unit was enumerated and where it ranked; also `kth`, `sqrt`, `topological_ordering` with the sieve vs the prototype loop, 3 repeats; ≈ $0.30. | ≥ 8/12 in ≥ 2 of 3 with 0 regressions kept; the 3 trap programs repair in ≥ 2 of 3. | one goal per failing test, immediate partial commits (prototype behaviour, measured 32/40). |
| **R4** | **Ranking at repository scale.** Every ranking number is from ≤ 254 (once 934) candidates of 10-line programs; SWE sites have 1,641 mutants, 25–175-line listings, pytest text failures; a reshuffle moved `kth` 0.48 → 0.14; 150-chunk requests were never run end to end. | Decides whether SWE is 3 or 0. | `experiments/repair-search/rank-at-scale.mts`: 9 reachable instances at `base_commit` (worktrees under `/tmp/jevonly/repos/`), real candidates at the gold anchor (cap 2,000) + the gold line, chunked compact Nouls at 150 and 254 + Q10, 3 shuffles; gold rank, max Noul, `fixProbablyAbsent`, tokens, cost, p50; plus 5 wrong sites per instance for false positives; ≈ 600 requests ≈ $0.15. And `hunk-subsets.py` ($0) for the minimal passing hunk subset. | gold ≤ 5 on ≥ 6/9 with median max-Noul ≥ 0.5 and ≤ 1 false positive at p ≥ 0.5 per wrong site. | SimFix-style similarity pre-filter to the top-300 by Jaccard to the buggy line; or SWE sites take donors + templates only, mutation restricted to `qualify_name`, `comp_filter`, `ident_sub` at function scope. |
| **R5** | **Names from the issue text as a vocabulary source, and the sketch pool as a size reducer at SWE scale.** 15/30 SWE fixes need a token absent from file + tests; 5 of 21 template matches fail only on a slot name; the sketch Choice was measured on 10-line programs with the position given. | The only lever above the 9/30 coverage ceiling. | extend `experiments/grammar-synthesis/sketch-probe.mts` with `--swe`: the 33 SWE depth-1 lines and the 21 ladder hunks, sketch Choice with (a) plain, (b) executed sub-expression values in the state, (c) two concrete instantiations per sketch description, plus a Choice "which of these `problem_statement` words names the new parameter/attribute" on the 5 slot-name failures; ≈ $0.05. | sketch top-3 ≥ 60 % on SWE lines and the name Choice ≥ 4/5. | keep the sketch round QuixBugs-only; SWE reach stays 9/30. |
| R6 (contract) | Lanes inside the workspace, `--resume` losing `tried` / `widenCursor`, the runner's JSON surviving the 600-char window tail. | Reliability, not reach. | unit test with the real seatbelt profile that `.jevcode-synth/` and `.git/worktrees/` are writable; resume test on a checkpoint after a WIDENED step. | `SynthesisContext.runDir` and `CheckpointState.synthState` land. | lanes under `<workspace>/.jevcode-synth/` with `.git/info/exclude`; re-run lost candidates. |

---

## 10. Decisions taken, and what was rejected from the four designs

| Decision | Taken from | Rejected alternative (and why) |
| --- | --- | --- |
| unit of work = one failing-behaviour cluster per step, ledger with park/re-open, fixed-form plan items, `patch → run` alternation | test-driven §1–§4 | contrarian's "pairs of partials only" (3-hunk ladder tasks unreachable by construction, judge 1); grammar-synthesis's `done` after its own sandbox run (contradicts DESIGN §5.5 `testsCurrent`, judge 3) |
| ranker = tests when `|cands| ≤ floor(testWall × lanes / t_run)` and `t_run ≤ 2 s`; Jev ordering otherwise | contrarian §0, §3.3 | test-driven / repair-search fixed K_VERIFY = 3 everywhere (compact top-3 36/40 at N = 254 misses 4/40; prototype `ranking_missed` 2/40, judge 2) |
| K = 5 at insert sites and above N = 60; full-criteria Nouls at N ≤ 150 | repair-search §3.1 + judge 2 correction | "top-3 holds 39/40 at every N" (full-criteria figure misapplied to compact Nouls) |
| overfit guard = behaviour clustering → Q15 + Q16 only among passers; suspect = escape ≥ 0.9 ∧ max Noul < 0.1; never withhold a lone passer | contrarian Tables 0.3–0.4 + judge 2 corrections | test-driven Q11 / repair-search Q-V1 / grammar-synthesis Q-GENUINE ≥ 0.7 gate (unmeasured; gold Nouls are < 0.7 on 4/10 and 0.15 on `quicksort`); contrarian's "best Noul < 0.3 → do not propose" and its Jev-free single-cluster commit (reproduces the `depth_first_search` overfit) |
| insert gaps before/after top-3 anchors as `Site`s; Q6 only when a statement exists | repair-search §1.4, test-driven Q5b | Q6 as a single pick (2/4 without the statement) |
| SBFL top-5 unioned on single files, top-3 on repos; `def` lines never | repair-search §1.4 | contrarian's `p_jev + 0.5 · ochiai` score combination (unmeasured weights) |
| WIDENED brute force over all lines as a later step, single-file only | contrarian Table 0.2 | test-driven's "widen to all lines" without a cost bound (it is 24–119 s per program) |
| partials held as a second base (B = 2, depth ≤ 3), committed only at exhaustion; pairs of partials ≤ 10 runs | test-driven §1.7, repair-search §3.1, contrarian source 5 | prototype greedy adoption (3 trap failures over two runs) |
| sketch Choice + slot fill as a reach round before the token beam; K = 3/5 rule; Q7 measured wording as a soft prior | grammar-synthesis §1.2, Appendix A | grammar-synthesis's sketch-first engine (not a precision layer, 29–31/40 top-3; adds no reach on QuixBugs, judge 1); test-driven's unmeasured `edit_class` wording |
| adaptive per-test timeout clamp(3 × baseline, 0.5 s, 2 s) | contrarian §3.2, Table 0.2 | fixed 2 s (timeout-dominated programs 2–4× slower) |
| `plan.openProblems` = human notes only; machine state requested as `CheckpointState.synthState` | judge 3 | contrarian's `synth: sites=… tested=…` grammar line (Jev-visible in the risk stage) |
| lanes: candidatePath / `git worktree` / `cp -R`; no `cp -al` | repair-search §3.2 + judge 3 | test-driven's `cp -al` hard links (GNU-only) |
| 150-candidate chunks on repository states; shuffle-and-average re-ask at margin < 0.10 when `t_run > 20 s` | repair-search §1.5 | 254-chunks everywhere (18k tokens on 10-line programs; cap 32k) |
| `hunk-subsets.py` ($0) and `rank-at-scale.mts` ($0.15) before any live SWE condition | repair-search §8 | scheduling SWE on the 9/30 coverage number alone |

---

## 11. Sources

`experiments/designs/test-driven-decomposition.md` (spine), `contrarian.md` (§0 Tables 0.1–0.4, §3),
`repair-search.md` (§1.3–1.5, §3, §8), `grammar-synthesis.md` (§1.2–1.5, Appendix A);
`experiments/results/judge-1-reach.md`, `judge2-reliability-cost.md`; the integration judge's inline verdict;
`experiments/results/anchor-probe.md`, `prototype-baseline.md` (+ `.jsonl`, `-run1.jsonl`), `probe-localization.md`,
`probe-selection.md` (+ `.raw.jsonl`, `.noescape.jsonl`, `.verify.jsonl`), `probe-question-design.md`,
`probe-progress-judgment.md`, `probe-donor-and-templates.md`, `probe-token-synthesis.md`,
`probe-swebench-understanding.md`, `coverage-study.md` (+ `.json`), `lit-search-based-repair.md`,
`lit-guided-synthesis.md`, `contrarian-exhaustive.{truth,all}.jsonl`, `contrarian-arbitrate.{truth,all}.jsonl`;
`experiments/grammar-synthesis/out/sketch-*.json`; `bench/data/ladder/README.md`;
`bench/data/swebench-verified-30.json`; `docs/JEV-ONLY.md`; `docs/DESIGN.md` §5.5, §6, §9, §21;
`src/core/types.ts` (`SynthesisContext`, `Synthesizer`, `Proposal`, `CheckpointState`, `Sandbox`);
`src/synth/types.ts`, `src/synth/*/index.ts`; `/Users/prateekjannu/Documents/jev-research/REPORT.md` §7–11, §14.
