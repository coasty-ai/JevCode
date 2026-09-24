# Repair-search: the Jev-only synthesis engine as search-based program repair

Design, 2026-09-20. Angle: **localise → enumerate (mutations, templates, donors) → Jev-rank → test-verify →
beam**, generation (token/slot beam) only as a last resort. Target: QuixBugs-class bugs and small SWE-bench
fixes, maximal reliability. Fills the `Synthesizer.synthesize(ctx) → Proposal` slot of `src/core/types.ts`
(DESIGN.md §21). No generating LLM anywhere: code proposes, Jev (Noul / Choice / Score) decides, tests decide
last. Every number below is quoted from a verified file under `experiments/results/`; every Jev question is
one that a probe already asked with that wording, unless it is marked **UNMEASURED**.

No live Jev calls were made for this document (spend $0.00). The measurements it rests on cost, in total,
about $2.0 across the eleven result files; each is cited by file name and number.

Files read in full: `anchor-probe.md`, `prototype-baseline.md`, `probe-localization.md`, `probe-selection.md`,
`probe-donor-and-templates.md`, `probe-question-design.md`, `probe-progress-judgment.md`,
`probe-token-synthesis.md`, `probe-swebench-understanding.md`, `coverage-study.md`,
`lit-search-based-repair.md`, `lit-guided-synthesis.md`; `docs/JEV-ONLY.md`; `docs/DESIGN.md` §4–6, §21;
`jev-research/REPORT.md` §7–11, §14; the existing `src/synth/*` modules (localize, mutate, templates, donor,
beam, rank, verify, sbfl, py; `src/synth/search/` does not exist yet and is what this design specifies).

---

## 0. What the measurements say, in one table

The design is a consequence of these eleven facts. The rest of the document is how to wire them.

| # | Fact | Number | Source |
| --- | --- | --- | --- |
| F1 | A line-replacement loop (localise Choice → 200 first-order mutants → Choice per line → verify top-5 → greedy progress) already repairs most of QuixBugs | **32/40** end to end (31 correct by inspection), $0.035 total, mean 5.3 Jev requests, 10.3 test runs, 3.2 s per program | `prototype-baseline.md` Totals |
| F2 | Its 8 failures are 4 coverage (insertions + one two-edit line), 2 localisation (true line rank 6 at p 0.02–0.03), 2 greedy-progress traps; every failure hit the **40-test-run** cap while using ≤ 14/30 Jev requests | tests, not Jev, were the binding resource | `prototype-baseline.md` Failure taxonomy, Budgets |
| F3 | Localisation with the actual output of the failing test in the state is the only wording that moved top-1; it is a beam, not a pick | top-1 28/40, top-3 36/40; Choice top-3 ∪ Noul-per-line top-3 covers **38/40** | `probe-localization.md` §1, §8.2 |
| F4 | Batched Nouls beat a flat Choice for ranking once N > 10; the fix is in the Noul top-3 at every size | Nouls top-1 39/40 (N=50), 31–32/40 (N=254); top-3 39/40 at every N; Choice decays 36→26/40 | `probe-selection.md` Summary |
| F5 | The unchanged line must not be a candidate; candidates go in option descriptions; include expected AND actual | 19/20 top-1, **20/20 test-passing** top pick, 0 confident misses | `probe-question-design.md` §5, §6 |
| F6 | First-order mutation of the buggy line reaches almost every QuixBugs fix; insertions need templates/donors; depth ≤ 2 + donors reaches all | gold first-order 38/40; mutation d≤2 36/36 modified lines; union 40/40 | `probe-selection.md` Operator library; `coverage-study.md` QuixBugs tables |
| F7 | "Fix not in set" is detectable as a routing signal, not a verdict | Choice `P(escape) − p_max ≥ 0.10` AUROC 0.916 (82 % / 13 % FA); Nouls `max < 0.5` AUROC 0.86 | `probe-selection.md` detector tables |
| F8 | Progress must be computed in code; Jev reads the numbers perfectly but adds nothing when they exist | 240/240 on `both` state; policy Choice wrong on 6/10 partials until the deltas were in the state | `probe-progress-judgment.md` Parts 1–2 |
| F9 | Given the correct statement, Jev places an insertion 4/4 and fills a changed identifier hole 13/13; donor line among ≤ 254 lines 32–35/36 | placement 4/4; holes 13/13 (leak-free re-run); donors 35/36 → 32/36 as pool grows to 254 | `probe-donor-and-templates.md` headline |
| F10 | Generation by Choices works but only as a portfolio inside a search | token beam W=3+grammar 20/40 lines at $0.0037; portfolio 27–28/40; slot filling with shape given 76–92 % | `probe-token-synthesis.md` T4; `lit-guided-synthesis.md` §5.2 |
| F11 | On the 30 SWE-bench instances, localisation is strong and proposal coverage is the ceiling | file #1 23/30, chained file∧fn∧line 21/30; fully reachable fixes **6/30** (9/30 with 2-sub donors); median 1,641 mutants per line | `probe-swebench-understanding.md` headline; `coverage-study.md` headline |

Design consequences, one line each: (F1, F2) keep the prototype's skeleton, spend Jev instead of tests;
(F3) localisation is a beam of sites incl. insertion gaps, unioned with SBFL; (F4, F5) rank with compact Nouls
in ≤ 254-chunks, never offer the unchanged line; (F6) mutation → templates → donors → second-order, in that
order; (F7) `fixProbablyAbsent` moves to the next source *before* spending test runs; (F8) the search policy is
an if-chain over code-computed deltas, and progress is a **beam of bases (B = 2)**, not a commitment; (F9)
insertion sites carry donor/template statements and Jev places them; (F10) the token/slot beam is the last
source, only when everything cheaper reports "fix absent"; (F11) on SWE-bench the loop decomposes per failing
test and per hunk and reports the unreachable two-thirds honestly.

---

## 1. The algorithm

### 1.1 Data model (from `src/synth/types.ts`, already frozen)

- `Site` = `{ file, line, kind: 'replace' | 'insert', currentLine, indent, block, scope, evidence }`.
- `Candidate` = `{ id, site, text, source, op, extraEdits?, prior? }`; `AppliedCandidate` = files before/after + diff.
- `TestRunSummary` = counts + `failing[]`, `passing[]`, `failures: FailureView[]` (`{ testId, call, expected, actual }`).
- `Progress` = `{ before, after, newlyPassing, newlyFailing, allPass, improved, regressed }` (all code-computed).
- New in this design (module `search/`): `Base` = `{ id, edits: AppliedCandidate[], summary: TestRunSummary, depth }`;
  `SearchMemory` = `{ bases: Base[] (beam, B ≤ 2), tried: Set<sha12(diff)>, siteCursor, sourceCursor, budget }`.

### 1.2 One `synthesize(ctx)` call, as pseudo-code

```
synthesize(ctx):                                   # one outer-loop step → exactly one Proposal
  mem  ← SearchMemory.for(ctx.runId) or rebuild(ctx.window, ctx.plan)      # §4.3
  info ← oracle.detect(ctx.workspaceInfo, ctx.contextFiles, ctx.task)      # test command, runner kind, FAIL_TO_PASS ids if the task names them

  # Phase A: reproduce (first step of a run, or after --resume with no baseline)
  if mem.bases is empty:
      if ctx.window has no executed `run` of info.command with a parsed summary:
          return Proposal(run info.command, goal "reproduce: run the tests", plan.remaining=[…])   # P-RUN, §4.1
      base0 ← Base(edits=[], summary=parseWindow(ctx.window))            # counts and failure texts from the window
      if base0.summary.allPass: return Proposal(done "tests already pass")                        # P-DONE
      mem.bases ← [base0]

  # Phase B: localise (once per base; cached in mem)
  for base in mem.bases without sites:
      base.sbfl  ← sbfl.runSbfl(failing ∪ passing tests, files of interest)   # code; Ochiai; 0 Jev requests
      base.loc   ← localizer.localize({ task, files, failures: base.summary.failures, traceback, sbfl })   # Q-L1..Q-L5
      base.sites ← loc.sites (replace sites at anchors ±3, insert gaps after/before each anchor)             # §1.4

  # Phase C: search, one base at a time, in beam order (higher passed count first, then Noul p)
  for base in mem.bases:
    for site in base.sites (in evidence order):
      for source in [mutation, template, donor, second_order, beam]:        # §2 order; `beam` only per §2.4
        cands ← source.enumerate(site, opts) \ mem.tried \ {site.currentLine}
        if cands empty: continue
        rank  ← ranker.rank(cands, {task, failures, functionListing})       # Q-R1/Q-R2/Q-R3, §1.5
        if rank.fixProbablyAbsent and rank.top.p < 0.5: continue           # F7: next source before spending tests
        queue ← rank.ranked with p ≥ P_VERIFY (0.5), else the top 3        # §3.1
        for cand in queue, verified in parallel groups of P (§3.2):
          if budget.testRuns exhausted: break out to Phase D
          applied ← verifier.applyCandidate(cand, base.files)
          after   ← verifier.runTests(info.command, applied) in a scratch copy
          prog    ← verifier.progress(base.summary, after)                   # code (F8)
          mem.tried.add(sha12(applied.diff))
          move ← route(prog, searchState)                                    # verify/progress.ts if-chain
          switch move:
            accept_and_stop:      winners.push(applied)                      # keep testing this queue: cluster guard needs ≥ 1 more pass (§3.4)
            accept_and_continue:  mem.bases.pushIfBetter(Base(base.edits+applied, after, depth+1)), keep B=2, do NOT restart   # beam, not commitment
            revert_try_next | widen_sources | revert_relocalise: continue     # nothing applied to the workspace; scratch discarded
        if winners: goto Phase D
  # exhausted: no candidate passes at any site of any base
  Phase D:
    if winners:
      win ← chooseWinner(winners)                                            # §3.4 cluster guard (Q-V1/Q-V2, UNMEASURED) or single
      if not fullSuiteRun(win) and info.hasWiderSuite: run the whole suite once on win in scratch; drop win on regression
      return Proposal(patch win.diff, goal "fix <site.file>:<line> (<op>): <one-line summary>",
                      plan: done += ["candidate passes N/N tests in scratch"], remaining = ["run tests in workspace", "finish"])   # P-PATCH
    if budget.hit or every site/source exhausted:
      return Proposal(done "no candidate passed; tested T of C candidates at S sites (sources: …)")      # P-DONE-FAIL, §4.4
    return Proposal(run info.command, goal "re-baseline after partial progress")                          # P-RUN (rare)
```

The workspace is touched only by the `patch` the outer loop executes after its risk stage; every candidate
run happens in a scratch copy (§3.2), so a rejected candidate never needs a revert action.

### 1.3 Every Jev question in the algorithm

All questions are built with `choice()` / `noul()` / `contextNoul()` from `src/jev/questions.ts` (escape
option, snake_case keys, criteria as definition + examples). Wordings are the measured ones, quoted. State
shapes are JSON objects; every instruction names its target by backticked path; nothing asks Jev to count.

| Id | Where | Type | Options (code-built) | Instruction (verbatim from the probe) | Consumed as | Measured |
| --- | --- | --- | --- | --- | --- | --- |
| **Q-L1** `must_change_<path>` | localise, multi-file workspaces (SWE-bench) | one Noul per file, ≤ 250 per request, batches in parallel, criteria once in `state.criteria` | every source `.py` path (tests/docs/migrations excluded) | "Must the file `<path>` (listed in `files`) be modified to fix `issue`? Apply `criteria`." criteria `yes_when` "the code change that fixes the issue lands in this file: it defines the function, class, table or constant whose behaviour the report describes as wrong or missing" / `no_when` "the file merely imports, calls or tests the code that is fixed elsewhere, or is unrelated to the symptoms" | ranked by p, **top-5 kept** (never thresholded) | gold #1 23/30, ≤5 28/30, ≤10 30/30, MRR 0.85, $0.0011/instance (`probe-swebench-understanding.md` Q6) |
| **Q-L2** `must_change_<path>` (confirm) | localise, on the Q-L1 beam | Noul per file with `top_level_symbols` outline | the 5 beam files | "Must the file `files["<path>"]` be modified to fix `issue`? Answer yes only if the code change that fixes the issue lands in this file." true: "the fix edits code in this file" (+2 examples); false: "the fix does not touch this file" (+2 examples) | re-rank the beam | gold first 31/33 packages, P 0.96 @0.7 (Q3 `outline`) |
| **Q-L3** `fix_function` | localise, per beam file | Choice over defs (signature line as description) + `module_level_code_outside_any_function` + escape | ≤ 254 functions, evidence-named ones first when more | "`file` is the source file that must be edited to fix `issue`. Which entry of `file.functions` must be modified (its body changed, or new code inserted directly into it) to fix the issue? If the fix is code outside every function, pick `module_level_code_outside_any_function`." | joint score = P(file) × P(fn); **global top-5 functions** | top-1 19/37, **top-5 35/37**, MRR 0.70 (Q2 `ps`) |
| **Q-L4** `buggy_line` | localise, per beam function (or the whole file when single-file) | Choice, keys `line_<k>`, description = line text (+ enclosing def when the text repeats), + escape | code lines of the function, centred window ≤ 254 | "Which line of `program` contains the bug? Pick the single line that must change so that the function is correct. Choose `none_of_these` only if no listed line is faulty." with `failing_test_run: { input, expected, actual }` in the state and the task text "… `failing_test_run` shows what the buggy program actually did on one failing test." | **top-3 anchors** per function; escape mass ignored (falls through to ranking) | variant D: top-1 28/40, top-3 36/40, MRR 0.805, ~1,200 tokens, $0.00005, p50 176 ms (`probe-localization.md` §3.1); SWE Q4 within ±3: top-5 94 % |
| **Q-L5** `line_<k>` | localise, same request as Q-L4 (single-file only) | one Noul per code line, criteria definition + 4/3 examples | same lines | "Is line `program.L<k>` the line that must change to fix the bug in `<fn>`? Judge this line only; other lines are judged separately." true: "This line contains the defect: changing this line, and only this line, makes every test pass. The wrong operator, bound, argument, index, condition or return value is on this line." false: "This line is correct as written. It may compute a value the faulty line misuses, be a `def` line, or an unrelated statement." | its top-3 unioned with Q-L4's top-3 (38/40 coverage); a single line at p ≥ 0.9 short-circuits the beam (17/17) | variant C: top-1 24/40, top-3 35/40; 3.3× tokens ($0.00015/program) (`probe-localization.md` §3.1, §4) |
| **Q-R1** `fix` | rank, N ≤ 10 | Choice, keys `candidate_<xx>`, **description = candidate text**, + escape "No option is a correct fix; every option leaves the tests failing or breaks the function." | candidates minus the unchanged line, duplicates folded | "Which option is the corrected line that, put in place of `buggy_line`, makes every test in `tests` pass, including the tests that currently fail? Read each option literally: most options are wrong mutations of the faulty line or copies of other lines. Choose `none_of_these` if no option is a correct fix. Answer carefully and literally." (insert sites: "…the missing statement that, inserted immediately after `buggy_line`…") | ranked by P; `fixProbablyAbsent` = `P(escape) − p_max ≥ 0.10` | top-1 36/40 at N=10 (`probe-selection.md`); 19/20 top-1, 20/20 test-passing with the unchanged line removed (`probe-question-design.md` S_combo_no_unchanged) |
| **Q-R2** `is_fix_<xx>` | rank, 10 < N ≤ 254 (one request; Q-R1 sent in the same request for the escape signal when N ≤ 60) | compact `contextNoul` per candidate, criteria once in `state.correct_fix_criteria` | as Q-R1, candidates in `state.candidates` | "Is `candidates.cand_<xx>` the corrected line: put in place of `buggy_line`, does it make every test in `tests` pass?" criteria: "The candidate repairs the exact mistake so the function returns `expected` for every test input, including the tests that currently fail, and stays correct on the tests that already pass." / "The candidate leaves the bug in place, introduces a different bug, or changes something unrelated to the failure." (+ examples both sides) | ranked by Noul p (absolute); `fixProbablyAbsent` = `max p < 0.5`; **verify every candidate with p ≥ 0.5, else top-3** | compact: top-1 39/37/32/32 of 40 at N = 10/50/150/254, top-3 40/40/38/36; 18k tokens, $0.00077, 331 ms at N=254 (`probe-selection.md`) |
| **Q-R3** `fix` (two-stage) | rank, N > 254: Q-R2 in ⌈N/254⌉ parallel chunks, then | Choice over the 5 highest Nouls + escape (Q-R1 wording) | Noul top-5 | as Q-R1 | final order = Choice P over the shortlist, Noul p breaks ties; escape ≥ 0.5 → "none shortlisted" routing | 33/40 top-1, fix shortlisted 39/40, plausible 36/40, ≈$0.0025, ≈0.8 s (`probe-selection.md` Two-stage) |
| **Q-I1** `insert_after` | insert sites when a statement candidate is known (donor/template) but the gap is uncertain | Choice over `before_l1`, `after_l<i>` ("insert directly after L<i>: <line>") + escape | gaps of the located function | "Where in `program` must `missing_statement` be inserted so that all `tests` pass?" | replaces the ±1 gap enumeration by one request when > 6 gaps | **4/4** top-1 with the statement given, 2/4 without (`probe-donor-and-templates.md` §4) |
| **Q-H1** `hole_<k>` | donor adaptation, one template per request (no sibling leak) | Choice over in-scope identifiers ∪ 22 builtins, keys `ident_<name>` | ≤ 45 options + escape | "Which identifier, in scope in `program`, fills `__HOLE__` in `replacement_templates.hole_<k>` so that the completed line at `program.L<n>` makes all `tests` pass?" | top-2 fillings kept as candidates (same-family pairs `i/j`, `a/b` go to the tests) | **13/13** changed-identifier holes, P p50 0.98 (leak-free re-run) |
| **Q-T1** `attack_first` | SWE-bench only, when > 1 FAIL_TO_PASS test | Choice over `failing_test_<id>` (≤ 10) + escape | failing tests with input/expected/actual | "Which entry of `failing_tests` should the repair attack first?" | orders the per-test work queue; code tiebreak on input size | 16/34 simplest vs 8/34 chance, MRR 0.67 (`probe-progress-judgment.md` Part 3) |
| **Q-P1..3** `program_correct`, `made_progress`, `broke_something` (+ Score `closeness`) | after each verification, **consistency check only** | Nouls with criteria; state `both` (counts + `newly_passing_tests`, `newly_failing_tests` + failure texts) | – | as `probe-progress-judgment.md` (verbatim in `src/synth/verify/questions.ts`) | disagreement with the code verdict (|p − truth| > 0.5) → transcript warning "summariser mismatch"; never routes | 240/240 on `both`; the route is code (F8). Asked only when the summariser produced no ids (pytest killed / unknown runner) |
| **Q-V1** `genuine_fix` **UNMEASURED** | cluster guard, when ≥ 2 distinct candidates pass all tests | Noul per passing candidate, criteria | – | "Given `failing_before` (the tests that failed and what the program did), `diff` and `tests_after`, does `diff` fix the cause shown by `failing_before`, rather than only making these tests pass? Answer carefully and literally." true: "the change corrects the operation the failing outputs point at (the bound, operator, argument, guard or statement whose absence produced `actual`)" (+examples); false: "the change special-cases the tested inputs, deletes or bypasses functionality, or makes the tests pass for an unrelated reason" (+examples) | prefers the candidate with the higher p when clusters disagree; a p < 0.3 candidate is never proposed while another passes | to be measured (Risk 2, §8) |
| **Q-V2** `behaviour_cluster` **UNMEASURED** | cluster guard, when passing candidates disagree on generated inputs | Choice over clusters (one representative diff + its outputs on the extra inputs) + escape | ≤ 6 clusters | "Each option is a group of candidate fixes that behave identically on `extra_inputs`. Which group's outputs are what a correct `<fn>` returns for `extra_inputs`, judging from `tests` and `failing_before`?" | pick the cluster; fall back to the one with the highest Q-V1 p | to be measured (Risk 2, §8) |
| **Q-B1** `shape`, **Q-B2** `slot_<k>`, **Q-B3** `next_token` | last-resort generation (`src/synth/beam`) | Choice over line shapes (buggy line's shape with a hole / fragment / deletion, donor shapes, statement templates); Choice per slot over identifiers/operators/literals; grammar-filtered next-token Choice, W=3 | as `probe-token-synthesis.md` §4 and `lit-guided-synthesis.md` §5.1 | verbatim from those probes | every completed line becomes a `Candidate` of source `token_beam` and goes through Q-R2 and the tests like any other | shape 15/17 when covered (coverage 17/40); slots 35/40 sequential; W=3+grammar 20/40 any-of-top-3 passes at $0.0037/line; portfolio 27–28/40 |

The verification stage asks **no gating question**: `route()` in `src/synth/verify/progress.ts` is a total
if-chain over `allPass`, `improved`, `regressed` and the code-computed search counters (F8).

### 1.4 Sites: how localisation output becomes a work list

Per base, from `LocalizeResult.sites` (already built by `src/synth/localize/sites.ts`) plus this design's rule
for insertion gaps:

1. **Replace sites**: each Jev anchor (Q-L4 top-3 per function ∪ Q-L5 top-3, single-file) and each SBFL
   top-k line (`sbflAnchors`: **5** for single-file workspaces, 3 otherwise) becomes a replace site; on
   SWE-bench each anchor also opens the ±3 window (Q4 top-5 within ±3 covers 94 % of functions, 97 % of
   primary functions). Order: Jev evidence first (P), SBFL-only lines after, `def` lines never (they took a
   request in 10 prototype programs at p ≤ 0.03).
2. **Insert sites**: the gap *after* and *before* each of the top-3 Jev anchors (all four QuixBugs insertion
   bugs have both neighbours of the insertion point within the top-5 of variant D: ranks 2, 3, 4, 5;
   `probe-localization.md` §3.4) and the gap after the last executed line of the failing test's trace when
   SBFL shows a line the fix never reaches (the `shunting_yard` case: the insertion point is inside a loop
   the buggy program never enters, `lit-search-based-repair.md` §6). Insert sites are visited only after the
   replace sites of the same anchor have been exhausted **or** when Q-L4 put ≥ 0.3 on `none_of_these`
   (the prototype named that option "the fix needs a new line").
3. Why SBFL is unioned rather than combined by score: on QuixBugs Ochiai is top-1 on 7/38 with heavy ties
   (7 programs have no passing test) but top-5 on 34/38, and the two prototype localisation misses (`lis`
   Einspect 3.0, `mergesort` 5.0) are inside its top-5 (`lit-search-based-repair.md` §7 table). The union of
   two weak-but-different rankers is what the measurements support; a learned combination is not.

### 1.5 Ranking: which method at which N (matches `src/synth/rank/index.ts`)

| N (distinct candidates, unchanged line removed) | Request(s) | Rank by | Absent signal | Basis |
| --- | --- | --- | --- | --- |
| ≤ 10 | 1: Q-R1 | Choice P | `P(escape) − p_max ≥ 0.10` | 36/40 top-1, escape wins 39/40 on no-fix sets at N=10 |
| 11–60 | 1: Q-R1 + Q-R2 together | Noul p | both (either flags) | Nouls 37–39/40 vs Choice 31/40 at N=50 |
| 61–254 | 1: Q-R2 (compact) | Noul p | `max p < 0.5` | 32/40 top-1, 36–38/40 top-3 at N=150–254 |
| > 254 | ⌈N/254⌉ parallel Q-R2 (8 concurrent) + 1 Q-R3 | Choice over Noul top-5, Noul p for the rest | Q-R3 escape ≥ 0.5 | 33/40 top-1, fix shortlisted 39/40; 26/34 top-1 over mean 295 real candidates (`lit-search-based-repair.md` §7) |

On SWE-bench the function listing in the state is longer, so the chunk is **150** candidates (the probe's
254-candidate request was 18k tokens with 10-line programs; the cap is 32k for state + longest question).

State shape for Q-R1/Q-R2 (verbatim `probe-selection.md`; `src/synth/rank/questions.ts` builds it):

```json
{ "task": "The Python function `gcd` has a one-line bug. `buggy_line` (line `buggy_line_number` of `program`) is the faulty line. `tests` shows inputs, the expected output, and what the buggy program actually does.",
  "program": { "L1": "def gcd(a, b):", "L2": "    if b == 0:", "...": "..." },
  "buggy_line_number": "L5", "buggy_line": "        return gcd(a % b, b)",
  "tests": [ { "input": [13, 13], "expected": 13, "actual_with_bug": "RecursionError: maximum recursion depth exceeded (unbounded recursion)", "status_with_bug": "exception" } ],
  "correct_fix_criteria": { "correct_fix": "…", "correct_fix_examples": ["…"], "not_a_fix": "…", "not_a_fix_examples": ["…"] },
  "candidates": { "cand_aa": "        return gcd(b, a % b)", "...": "..." } }
```

`program` is the enclosing function's listing (bounded, `functionListing` in `RankContext`), never the whole
file; `tests` are the failing tests first, ≤ 3, with `actual_with_bug` from the real run (F3/F5).

**Order sensitivity.** With ~300 near-duplicate candidates, re-keying and reshuffling moved mid-range items
by up to 0.34 (`kth` 0.48 → 0.14, `next_permutation` 0.19 → 0.52; `lit-search-based-repair.md` verification).
Rule: when tests are cheap (QuixBugs, < 2 s per run) fall through to the tests; when a test run costs
> 20 s (SWE-bench) and the top-2 Noul margin is < 0.10, re-ask the shortlist (≤ 10 candidates) once with a
shuffled order and average the two p's before spending a run (one extra request, ~$0.0002).

---

## 2. Candidate sources and their order

Order is by measured yield per request and per test run; a source is skipped when the previous one at the
same site did not flag `fixProbablyAbsent` and still has unverified candidates with p ≥ 0.5.

| Order | Source (module) | What it enumerates at a site | Cap | Coverage evidence | Why here |
| --- | --- | --- | --- | --- | --- |
| 1 | **mutation**, first-order (`src/synth/mutate`, 27 operators incl. `boundary_shift`) | token-level edits of `currentLine`: relational/arith/bool/aug swaps, off-by-one (literal and atom), argument/operand/index swaps, negation, identifier/call/attribute/constant substitution from the enclosing scope, slice tweaks, wrap/unwrap call, drop term, return tweaks, condition extension, `method_to_assign`, `binop_with_identifier`; compile-shape filtered, deduplicated, prior-ordered | 254 per site (first 254 by prior; a second chunk only when the first flags absent) | gold first-order **38/40** QuixBugs (`probe-selection.md`); 34/36 modified lines at depth 1, 36/36 with `boundary_shift` (`coverage-study.md`); SWE-bench 33/78 modified lines | cheapest, highest yield; Jaccard(fix, buggy) ≥ 0.5 for 33/36 replacements: the buggy line is the best donor (`probe-donor-and-templates.md` design 2) |
| 2 | **templates** (`src/synth/templates`, 8 families) | guards (`if x is None: return …`), statement inserts (`x.append(y)`, `x.add(y)`, `y = x`, `return x` over in-scope names), wraps (`max(0, …)`, `abs`, `list`), condition extension (`C or not y`, `y is None or C`), signature/keyword args, attribute/callee substitution from file tables, missing imports (stdlib + repo verbatim), branch copies | 254 | insertions 4/4 via `insert_method_call_scope` / `insert_assign_scope` (`coverage-study.md` templates table); SWE-bench: guard insertion, add-parameter-default and missing import are the templates that fire (16/106 hunks) | the only source for insert sites on QuixBugs; TBar's catalogue is the literature's best template set (74 correct / 101 plausible on Defects4J with perfect FL, `lit-search-based-repair.md` §1) |
| 3 | **donor** (`src/synth/donor`) | (a) same-shape lines of the function/file/corpus with ≤ 2 identifiers rebound, (b) near-duplicates (Jaccard ≥ 0.5) with one substitution, (c) statement donors carrying their body as `extraEdits`; identifier holes filled by Q-H1 when the rebinding is too wide | 254 (tier order: same function < same file < corpus) | QuixBugs donor+≤2-sub 13/40 lines (4/4 insertions); SWE-bench donor+≤2-sub **51/106 hunks, 109/199 lines**, shape 139/199 (`coverage-study.md`) | the priority source on real repositories (plastic-surgery: 30 % of grafts in the same file); ranking among donors is 32–35/36 (F9) |
| 4 | **second-order mutation** (composition of two cheap operators; `SECOND_ORDER_LIMIT` 100) | pairs among the top-10 first-order operators' outputs | 100 | `shortest_paths` (`drop_index` ∘ `identifier_substitution`) and `mergesort` (`rel_swap` ∘ `off_by_one`) are the only depth-2 QuixBugs fixes; `boundary_shift` already makes `mergesort` first-order | only when sources 1–3 all flagged absent at the site: depth-2 pools are 5–10k lines (`coverage-study.md` sizes) and Long & Rinard's warning that bigger spaces find fewer correct patches (`lit-search-based-repair.md` §1) |
| 5 | **token/slot beam** (`src/synth/beam`: templates → sequential slots, then grammar-filtered token beam W=3, ≤ 48 requests) | shapes of the buggy line with a typed hole / fragment / deletion and statement templates; slots filled by Choice; completed lines | ≤ 3 completed lines per route | W=3+grammar 20/40, portfolio 27–28/40 (`probe-token-synthesis.md`); S2 diff-fill 92 % with the shape given (`lit-guided-synthesis.md` §5.2); the 12 lines it misses are additive fixes and long comprehensions | last resort: ~31 requests and 3.3 s per line vs one request for sources 1–3; on QuixBugs every line it can build is already a first-order mutant, so it earns its place only on lines outside the operator catalogue (SWE-bench new logic, `coverage-study.md` group 1) |
| 6 | **test-derived values** (`EnumerateOptions.testLiterals`, feeds 1, 2, 5) | literals from `expected` and the inputs of the failing tests | – | 0 uncovered tokens on QuixBugs; file+tests vocabulary covers 15/30 SWE fixes vs 13/30 file-only | not a source of its own; it widens the literal pool of every source |
| 7 | **history** (`git log -S<symbol>`) | past hunks touching the function, replayed as templates | – | not measured | listed for completeness; **not in v1** |

Never enumerated: mutations of `def` lines; the unchanged line (F5); candidates whose diff hash is in
`mem.tried`; candidates whose tokens fail the file+tests vocabulary check (a free pre-filter:
`coverage-study.md` design 6).

**Insertion candidates specifically.** Insert sites take templates (2) first, then statement donors (3c),
then mutation (1) is not applicable. The four QuixBugs insertion statements are all `x.f(y)` / `y = x` over
in-scope names; their compilable first-order pools were 295–682 candidates and Jev's Nouls put the gold
statement top-1 at N=254 for all four (`depth_first_search` 0.77, `reverse_linked_list` 0.59, `shunting_yard`
0.33, `wrap` 0.35; `probe-selection.md` per-program rows), but two sit at p ≈ 0.35 where a tie with a wrong
statement is one shuffle away. The verification queue therefore takes the **top-3** at insert sites even
when p < 0.5.

---

## 3. Verification strategy

### 3.1 How many test runs, and when

Tests were the binding budget in the prototype (all 8 failures stopped at 40 runs; 22 of 32 repairs needed
exactly one verification; `prototype-baseline.md` Budgets). The design spends Jev to make runs few:

| Situation | Rule | Basis |
| --- | --- | --- |
| Candidate Noul p ≥ 0.5 | verify now, in Noul order (all of them; typically 1–3 per site) | Nouls at N=50: P(fix) ≥ 0.5 on 30/40, top-1 plausible 40/40 |
| No candidate ≥ 0.5, not flagged absent | verify the top-3 | fix in Noul top-3 39/40 at every N |
| `fixProbablyAbsent` and top p < 0.5 | **zero runs**; next source | detector AUROC 0.86–0.92; a false alarm costs one source round, a miss costs three runs |
| Insert sites | top-3 regardless of p | `shunting_yard`/`wrap` gold at p 0.33–0.35 |
| Per outer step (one `synthesize` call) | ≤ 40 candidate runs (QuixBugs-class); ≤ 12 on repos where a run > 20 s; ≤ 60 Jev requests; wall ≤ min(180 s, `limits.commandTimeoutMs` × 3) | prototype means 10.3 runs / 5.3 requests; failures used ≤ 14 requests |
| Second base opened (partial progress) | finish the current base's queue first; then the new base gets its own localisation and the same per-site rules; beam **B = 2**, max depth 3 | greedy commitment lost `kth`, `sqrt`, `topological_ordering` (3 of 8 failures over two runs); the 3 genuine two-step repairs (`find_first_in_sorted`, `minimum_spanning_tree`, `sieve`) stay reachable |

Ordering across sites: a global queue keyed by (base passed-count desc, Noul p desc) so a p = 0.9 candidate at
the second site is verified before a p = 0.2 candidate at the first (`shortest_path_length` needed global
rank 10 in the prototype because widening only happened after k = 5 misses).

### 3.2 Parallelism through the sandbox

`Sandbox.run` executes one command with cwd = workspace, writes confined to workspace + run dirs. Candidates
are never applied to the workspace during search; each runs in a **scratch copy** under the run directory:

- **QuixBugs runner** (`bench/data/quixbugs/run_tests.py <name> <candidatePath>`): the candidate file is
  written to `<runDir>/synth/scratch/<k>/<name>.py` and passed as `candidatePath`; **P = 4** candidates run
  concurrently (four `sandbox.run` calls; each run is ≤ 20 subprocesses of ≤ 2 s). `PYTHONDONTWRITEBYTECODE=1`
  is already in `quixbugsTestCommand` (the stale-`.pyc` pitfall in `probe-question-design.md` §8).
- **pytest repositories**: P scratch worktrees `git worktree add --detach <runDir>/synth/scratch/<k> HEAD`
  (created once per run, reset with `git checkout -- . && git clean -fd` between candidates); the candidate's
  diff is applied with `git apply` inside the worktree; `python -m pytest -rA -q -p no:cacheprovider <test files>`
  runs there. The venv is the workspace's (`.venv/bin` on PATH, DESIGN §8). Non-git workspaces fall back to
  P = 1 in a copied tree (`cp -R` bounded to ≤ 50 MB, else sequential apply/revert in the workspace with the
  revert guaranteed by `finally`).
- Concurrency: Jev at 8 concurrent requests per site (128 allowed, REPORT §5), tests at P = 4; both under
  `ctx.signal`.

### 3.3 Timeouts and test selection

| Level | Runs on | Timeout | When |
| --- | --- | --- | --- |
| T0 baseline | all tests of the runner (QuixBugs) / the FAIL_TO_PASS test files named by the task or traceback, else the test files the localiser's file beam maps to (`tests/test_<stem>.py`), else `workspaceInfo.testCommand` | QuixBugs 2 s per case (runner), 120 s per run; pytest `min(limits.commandTimeoutMs, 120 s)` | once per run (P-RUN) and once per new base |
| T1 candidate | same set as T0 | same | every verified candidate |
| T2 regression | the whole detected suite (`workspaceInfo.testCommand`) | `min(limits.maxCommandTimeoutMs, 600 s, wall remaining)` | once, on the winner, before P-PATCH, only when T1's set is narrower than the suite; a regression drops the winner and continues the queue |
| SBFL trace | T0's set under `trace_lines.py` | T0 timeout + 15 s slack | once per base |

A timeout is a failing test with `actual = "Timeout: the program did not finish within N seconds (probable
infinite loop)"`, which Jev used correctly for `bitcount`, `sqrt`, `breadth_first_search` (`probe-localization.md`
§8.1).

### 3.4 Accepting a winner: cluster guard against overfitting

Tests overfit at least once in 40 on QuixBugs (`depth_first_search`'s "repair" satisfies its 5 tests;
`prototype-baseline.md`), and 53 % of plausible QuixBugs-Java patches from classic tools were overfitting
(`lit-search-based-repair.md` §4). The design's guard, **UNMEASURED** and gated by the experiment in §8:

1. Keep verifying the current queue until either a second distinct candidate passes or the queue is empty
   (bounded by the same run budget; typically ≤ 2 extra runs).
2. If exactly one candidate passes, and its Noul p ≥ 0.5, propose it. If p < 0.3, ask Q-V1 once; propose it
   unless Q-V1 < 0.3 **and** another source still has candidates (then keep searching one more source).
3. If ≥ 2 pass: generate ≤ 8 extra inputs by code (perturb the test inputs: ±1 on integers, drop/duplicate a
   list element, empty and singleton cases, swap two arguments of the same type), run the passing candidates
   on them in scratch, cluster by output. One cluster → they are equivalent; take the highest p. Several →
   Q-V2 picks the cluster (Q-V1 per candidate breaks ties). `next_permutation`'s `perm[j] > perm[i]` and
   `max_sublist_sum`'s commuted `max(0, x + …)` are equivalent and would cluster together; `possible_change`'s
   `total <= 0` over-fit at B = 5 would separate (`lit-guided-synthesis.md` §5.3).

The guard never overrides the tests: a candidate that fails a test is never proposed, and a candidate that
passes is proposed even when Q-V1 is low if it is the only one (the outer loop's judge and completion Nouls
see the diff and the run output anyway).

---

## 4. Plugging into the outer loop (DESIGN §6)

### 4.1 What one step is, and the Proposal kinds

One outer step = one `synthesize(ctx)` call = one `Proposal`. Internally the synthesizer may spend dozens of
Jev requests and test runs (all through `ctx.ask` and `ctx.sandbox`, so they land in `decisions.jsonl`,
`jev.jsonl` and the meter; §5 gives the budget). It returns exactly one of:

| Kind | Action | When | `goal` / `plan` | Passes risk because |
| --- | --- | --- | --- | --- |
| **P-RUN** | `{ kind: 'run', command: <T0 command> }` | step 1 of a run (no parsed baseline in `ctx.window`); after `--resume` without a baseline; after a P-PATCH, to make `workspace.lastTestRun` current (`testsCurrent` true) | goal "run the tests to reproduce the failure" / "confirm the fix"; `plan.remaining` = `["localise", "propose a verified patch", "run tests", "finish"]` minus what is done | `destructive` 0, `out_of_scope` 1 (setup the task plainly needs) |
| **P-PATCH** | `{ kind: 'patch', diff }` (unified diff over ≤ 2 files; `extraEdits` included) | a candidate passed T1 (and T2 when applicable) in scratch | goal "fix `<file>:<line>` (`<op>`): `<old>` → `<new>`"; `plan.done += ["candidate passes N/N tests in scratch (<source>/<op>)"]`, `remaining = ["run tests in the workspace", "finish"]`; `openProblems` = other passing clusters, if any | target is git-tracked → `recoverable` → `destructive` level 1; `plan_mismatch` 0 |
| **P-DONE** | `{ kind: 'done', summary }` | the previous step's `run` parsed `allPassed` and `testsCurrent` is true, or the baseline already passes | summary "N/N tests pass after patching `<file>:<line>`" ; `remaining = []` | `plan_mismatch` 0 when `remaining` is empty and a verifying run is in `recent` |
| **P-DONE-FAIL** | `{ kind: 'done', summary: "no fix found: tested T candidates at S sites (…)" }` | every source at every site of every base exhausted, or the per-run budget (§5) is gone | `openProblems = ["search exhausted: …"]`, `remaining` unchanged | expected to be **blocked** at `plan_mismatch` level 3 ("claims completion while `plan.remaining` is non-empty"); that is intended, see §4.4 |
| **P-READ** | `{ kind: 'read', paths }` | only under a `gather_context` replan directive on a multi-file workspace: the Q-L1 top-5 files not yet in `ctx.contextFiles` | goal "show the files the localiser ranked highest" | `destructive` 0 |

The synthesizer never proposes `edit` or `write` (a `patch` carries multi-line `extraEdits` atomically and
the engine already runs `git apply --check`), and never proposes `run` of anything but the test command or
`git worktree` housekeeping (which it runs itself through `ctx.sandbox`, not as a Proposal).

The intended happy path is four outer steps: **P-RUN → P-PATCH → P-RUN → P-DONE**. The judge stage on the
P-PATCH step sees `executed.changedFiles` and a diff; on the second P-RUN it parses the test counts
(`tests.source = 'parsed'`) so `workspace.lastTestRun.allPassed && testsCurrent` is true when the completion
Noul is asked on the P-DONE step (the completion criteria in DESIGN §5.5 require exactly that).

### 4.2 Plan and progress tracking

`PlanDraft` is written by code from `SearchMemory`, never free text: `done` items are facts with numbers
("baseline: 3/7 tests fail", "localised 6 sites in `gcd`", "candidate `return gcd(b, a % b)` passes 7/7 in
scratch"); `remaining` is the fixed ladder `["reproduce", "localise", "propose a verified patch", "run tests
in the workspace", "finish"]` with completed rungs removed; `openProblems` lists exhausted sources
("mutation exhausted at 6 sites (612 candidates, 9 tested)") and alternative passing clusters. The harness
judges each `done` claim with `done_<j>` against `executed` (DESIGN §6 Plan rules); the claims are phrased so
the evidence is in the output (test counts, changed files).

### 4.3 Memory across steps and `--resume`

`SearchMemory` lives in the synthesizer instance keyed by `ctx.runId` (bases, tried diffs, per-site cursors,
budget used, scratch worktree paths). On a fresh process (`--resume`) it is **rebuilt from `ctx.window`**: the
last executed `run` entry supplies the baseline summary (the window keeps the output tail, which holds the
runner's JSON line / pytest summary), executed `patch` entries mark accepted edits, and `plan.openProblems`
carries the exhausted-source list so the search does not repeat it. Everything else (localisation, ranking)
is recomputed; at ~$0.001 that is cheaper than a persistence format. **Contract note:** `SynthesisContext`
has no run-directory path; the scratch dir is derived from `ctx.workspace.root` + `.jevcode-synth/<runId>`
inside the workspace (the sandbox allows writes there) and is listed in `.git/info/exclude`; a `runDir`
field on the context would be cleaner and is the one contract change this design requests.

### 4.4 Loops, stuck, and "done"

- **The synthesizer never proposes the same diff twice** (`mem.tried`), so the engine's `patch:<sha>` loop
  signature cannot trip on it. The signatures that *can* trip are `run:<cmd>:<result>` (the same test command
  with identical results three times) and `done:<summary>` (three blocked P-DONE-FAILs). Both mean the
  search is stuck, which is exactly when the outer loop should replan.
- **Replan directives** (`ctx.directive`) are consumed in code: `change_approach` → enable the next source
  tier for every site (second-order, then the token beam) and widen localisation to all code lines of the beam
  functions; `gather_context` → P-READ of the Q-L1 top-5; `fix_environment` → P-RUN of `python -m pytest
  --version` style checks is *not* proposed (the synthesizer has no environment knowledge); it re-proposes the
  test run; `revert_changes` → nothing to revert (the workspace only holds verified patches), so the
  synthesizer answers with P-RUN and a plan note; `stop_and_report` is handled by the engine.
- **Stuck detection inside a step**: `route()` returns `give_up` when the budget is gone; `revert_relocalise`
  with `sitesRemaining = 0` triggers one widening (all code lines of the beam functions as sites, Q-L4 asked
  once more with `none_of_these`'s mass read as "insert somewhere": insert gaps after every line whose Q-L5
  p ≥ 0.1) and then P-DONE-FAIL.
- **"Done" means**: the T0 test set passes in the workspace (a `run` the outer loop executed and parsed,
  `allPassed`, `testsCurrent`), the T2 suite passed on the winner in scratch when it exists, and the completion
  Noul `task_complete ≥ 0.85` agrees. The synthesizer proposes P-DONE only when the first two hold in code;
  the Noul is the harness's check, never the source of the claim (JEV-ONLY non-negotiable 2). If the Noul
  rejects (`done rejected: task_complete=0.41` in the window), the next step proposes P-RUN again once, then
  P-DONE again; a third rejection trips `done:<sha>` and the replan stage takes over (DESIGN §6 done path).
- **Task impossible**: P-DONE-FAIL is blocked by the risk stage (plan_mismatch 3), three times → loop trip →
  replan Choice; the replan state carries the `openProblems` exhaustion text, so `stop_and_report` /
  `task_impossible ≥ 0.85` is the expected exit. This uses the existing machinery without a new stop reason.

### 4.5 Multi-hunk decomposition (ladder rung 2, SWE-bench)

Per failing test first (Q-T1 orders the FAIL_TO_PASS tests when there are several), per site second. A
candidate that makes the attacked test pass and regresses nothing opens a new base (depth + 1) even if other
tests still fail; the next outer step localises *from the new base's failures* (the localiser is re-run with
the diff in the state, the design implication of `probe-swebench-understanding.md` failure taxonomy
"multi-file fixes"). P-PATCH is proposed only when the T0 set passes entirely, so a two-hunk fix reaches the
workspace as one patch with `extraEdits`, or as two consecutive P-PATCH steps when the second hunk is found
only after the first base was accepted (the engine then sees `patch → run → patch → run → done`). Depth is
capped at 3 edits: 19/30 SWE gold patches have ≥ 2 code hunks, but a fix is proposed when the tests pass,
not when the gold is reproduced.

---

## 5. Cost and latency budget per step (from the measurements)

Constants: Jev p50 190–250 ms per request regardless of question count (every probe), $0.042 per million
input tokens, 8 concurrent requests per site, QuixBugs test run 0.2–1 s (2 s per case cap), pytest module run
5–60 s on the SWE-bench repos (bench venvs), SBFL trace ≈ T0 × 1.5.

### 5.1 QuixBugs-class step (single file, ≤ 40 lines, JSON/pytest oracle)

| Phase | Requests | Tokens / request | Cost | Wall | Basis |
| --- | --- | --- | --- | --- | --- |
| P-RUN baseline (outer step 1) | 0 | – | $0 | 1–3 s | runner |
| SBFL trace | 0 | – | $0 | 1–3 s | `lit-search-based-repair.md` §6 (`sys.settrace`) |
| Localise: Q-L4 + Q-L5 in one request | 1 | ~3,700 | $0.00016 | 0.2 s | variant D 1,200 + variant C 3,500 tokens |
| Rank: 3–6 sites × 1 request (mutation, N ≤ 254 compact Nouls) | 3–6 | 4,500–18,000 | $0.0006–0.004 | 0.4 s (parallel) | `probe-selection.md` compact rows |
| Rank: templates/donors at insert sites (only on miss) | 0–4 | ~10,000 | $0–0.002 | 0.4 s | – |
| Verify: 1–3 runs typical, ≤ 40 | 0 | – | $0 | 0.5–10 s (P = 4) | prototype: 22/32 repairs needed 1 run; mean 10.3 |
| Cluster guard (only when ≥ 2 pass) | 0–2 | ~3,000 | $0–0.0003 | 1–3 s | UNMEASURED |
| Second base (only on partial progress) | +1 loc, +3 rank | – | +$0.002 | +3–5 s | 6/40 programs opened one in the prototype |
| **Total, P-PATCH step** | **5–12 (max 60)** | – | **$0.001–0.006** | **3–15 s (max 180 s)** | prototype mean 5.3 req, $0.00088, 3.2 s; the Noul rerank adds ~4× tokens per rank request |
| Outer loop overhead per step (intent, context, risk, judge) | 3–4 | ~2,000 | $0.0003 | 0.8 s | DESIGN §6 |
| **Whole program: P-RUN → P-PATCH → P-RUN → P-DONE** | **≈ 20** | – | **≈ $0.003–0.008** | **≈ 10–30 s** | under the $0.05 / 2 min criterion by 6× / 4× |

### 5.2 SWE-bench-class step (repository, 60–780 source files, pytest oracle)

| Phase | Requests | Cost | Wall | Basis |
| --- | --- | --- | --- | --- |
| Q-L1 file Nouls, ≤ 250 per request | 1–4 (parallel) | $0.0011 | 0.3 s | Q6: 34,776 tokens per instance p50 |
| Q-L2 confirm (5 files, outlines) | 1 | $0.0002 | 0.25 s | Q3 |
| Q-L3 functions (5 files) | 5 (parallel) | $0.0005 | 0.25 s | Q2: 2,508 tokens p50, 12.6k max |
| Q-L4 lines (5 functions) | 5 (parallel) | $0.0004 | 0.25 s | Q4: 1,594 tokens p50 |
| SBFL trace on the FAIL_TO_PASS files | 0 | $0 | 10–90 s | T0 × 1.5 |
| Rank: 5 anchors × ±3 window → ≤ 35 replace sites, but candidates enumerated per **anchor line** (N median 1,641 mutants + donors) → ⌈N/150⌉ ≈ 11 chunks × 5 anchors + 5 Q-R3 | ~60 (8 concurrent) | $0.03–0.05 | 3–5 s | `coverage-study.md` sizes; 18k tokens per 254-chunk at QuixBugs line lengths, so 150 per chunk here |
| Verify: ≤ 12 runs of the failing test file(s), P = 4 worktrees | 0 | $0 | 1–10 min | 5–60 s per pytest module run |
| T2 full suite on the winner | 0 | $0 | 1–10 min | bench `eval.sh` scale |
| **Total, P-PATCH step** | **≈ 70–80 (cap 120)** | **≈ $0.04–0.06** | **3–20 min (cap: `limits.maxWallMs` share)** | tests dominate by two orders of magnitude |

Per-run caps (code, `search/budget.ts`, checked before every request and every run): Jev requests 60 (QuixBugs)
/ 120 (repo) per step; test runs 40 / 12 per step; wall 180 s / 20 min per step; the run-level `spend_cap`
and `wall_time` of the engine still apply on top (DESIGN §6 Budgets). At $0.06 per SWE step and four steps
per instance the whole 30-instance jev-only condition is ≈ $7 of Jev; the live jev-on run spent $24.21 on
29 tasks (`docs/STATUS.md`).

---

## 6. Predictions, with the measurement each rests on

### 6.1 QuixBugs, per program (n = 40)

Prototype outcome from `prototype-baseline.md` run 3 (and run 1 where it differs); the "design change" column
names the mechanism of this design that acts on the program; "measurement" is the number that mechanism rests
on; "predicted" is repaired end to end with tests as the only oracle (Y = expected, y = likely ≥ 0.6,
? = 0.3–0.6, n = unlikely).

| Program | Prototype (run 3 / run 1) | Failure class | Design change that acts here | Measurement it rests on | Predicted |
| --- | --- | --- | --- | --- | --- |
| bitcount | Y / Y | – | – | loc D 0.51 top-1; Nouls 0.95 r1 | Y |
| breadth_first_search | Y / Y | – | – | Nouls 0.92 r1 | Y |
| bucketsort | Y / Y | – | – | Nouls 0.90 r1 | Y |
| depth_first_search | Y (overfit alt) / Y | insertion; test-overfit | insert gaps after top-3 anchors + `insert_method_call_scope` template; cluster guard | gold `nodesvisited.add(node)` Nouls 0.84 r1 (N=50), 0.77 r1 (N=254); placement 4/4; guard UNMEASURED | Y (correct fix expected once the gold statement is in the pool; the overfit alt still passes, so the guard decides) |
| detect_cycle | Y / Y | – | – | Nouls 0.78 r1 | Y |
| find_first_in_sorted | Y (2 rounds) / Y | – | beam keeps the 2-step path | round-2 repair in the prototype | Y |
| find_in_sorted | Y / Y | – | – | Nouls 0.94 r1 | Y |
| flatten | Y / Y | – | – | 0.96 r1 | Y |
| gcd | Y / Y | – | – | 0.87 r1 | Y |
| get_factors | Y / Y | – | – | 0.75 r1 | Y |
| hanoi | Y / Y | – | – | 0.80 r1 | Y |
| is_valid_parenthesization | Y / Y | – | – | 0.95 r1 | Y |
| kheapsort | Y / Y | – | – | 0.69 r1 | Y |
| knapsack | Y / Y | – | – | 0.85 r1 | Y |
| kth | n / n | greedy trap (`k - 1` raised 3→5, fix rank 182/189 in Choice) | beam of bases finishes base-0 queue; Nouls instead of Choice | Nouls N=254: 0.51 r2 (max 0.63); N=50: 0.39 r1; `lit-repair` Noul 0.48 r2 | y |
| lcs_length | Y / Y | – | – | 0.46 r1 (weak) | Y (flip risk) |
| levenshtein | Y / Y | – | – | 0.84 r1 | Y |
| lis | n / n | localisation (true line rank 6, p 0.02) | SBFL top-5 anchors unioned (Ochiai Einspect 3.0) | `lit-repair` §7 table; fix `max(longest, length + 1)` Nouls 0.62 r1 | y |
| longest_common_subsequence | Y / Y | – | escape mass ignored (falls through) | Choice picks `none_of_these` 0.30–0.47 every run, Nouls 0.83 r1 | Y |
| max_sublist_sum | Y / Y | – | – | 0.94 r1 | Y |
| mergesort | n / Y | localisation (rank 6 / 3) | SBFL top-5 (Ochiai 5.0); `boundary_shift` makes `<= 1` first-order | Nouls 0.79 r1 | y |
| minimum_spanning_tree | Y (2 rounds) / Y | – | beam keeps the 2-step path | – | Y |
| next_palindrome | Y / Y | – | unchanged line removed (it was the attractor) | Nouls 0.31 r1 / Choice with unchanged line picked it at 0.70–0.85 | Y (flip risk: p 0.22–0.31) |
| next_permutation | Y (alt) / Y | equivalent alt passes | – | `perm[j] > perm[i]` passes; cluster = 1 | Y |
| pascal | Y / Y | – | – | 0.71 r1 | Y |
| possible_change | Y / n | loc rank 4–7 (innocent line) | SBFL top-5 (Ochiai 4.0); Nouls | Nouls 0.62 r1 | y |
| powerset | Y / Y | – | – | 0.92 r1 | Y |
| quicksort | Y (alt) / Y | – | – | 0.76 r1 | Y |
| reverse_linked_list | n / n | insertion | insert gaps + `insert_assign_scope` / donor+2-sub | gold Nouls 0.80 r1 (N=50), 0.59 r1 (N=254); placement 4/4 | y |
| rpn_eval | Y / Y | – | – | 0.84 r1 | Y |
| shortest_path_length | Y (rank 10) / Y | slow (loc rank 4, 200-cap) | global queue across sites; 254 cap | Nouls 0.81 r1 | Y |
| shortest_path_lengths | Y / Y | – | – | 0.90 r1 | Y |
| shortest_paths | n / n | two-edit line, not first-order | second-order source when first-order flags absent | Nouls 0.24–0.28 r1 with the fix injected (low, near tie) | ? |
| shunting_yard | n / n | insertion inside a never-executed loop | insert gaps + template; SBFL cannot see the site | Nouls 0.39 r1 (N=50), 0.33 r1 (N=254); loc neighbour rank 5 | ? |
| sieve | Y (2 rounds) / Y | – | – | – | Y |
| sqrt | n / n | greedy trap; fix rank 3 (p 0.15) tied with a false lead | beam of bases; Nouls | Nouls N=254: 0.15 **r12**; `lit-repair` Noul rank 42.5; token beam failed too | n (0.3) |
| subsequences | Y / Y | – | – | 0.76 r1 | Y |
| to_base | Y / Y | – | – | 0.93 r1 | Y |
| topological_ordering | Y / n | greedy trap in run 1 | beam of bases | Nouls 0.26 r1 (weak) | Y (flip risk) |
| wrap | n / n | insertion | insert gaps + `insert_method_call_scope` | Nouls 0.36 r1 / 0.35 r1; loc neighbour rank 2 | y |

Sum of expectations: 30 Y + (kth 0.7, lis 0.7, mergesort 0.7, possible_change 0.8, reverse_linked_list 0.7,
wrap 0.6, shunting_yard 0.5, shortest_paths 0.4, sqrt 0.3) ≈ 30 + 5.4 = **35.4**, minus the observed
run-to-run flip loss of 1–2 programs on items at p 0.2–0.5 (`lcs_length`, `next_palindrome`,
`topological_ordering`; 30 programs repaired in both prototype runs, 34 in at least one).

**Prediction: 34–36 of 40 repaired end to end (85–90 %), central 35; 33–35 correct by inspection** (the
cluster guard is unmeasured, so at least one overfitting acceptance should still be expected). Floor: 32
(the prototype; nothing in this design removes a mechanism that worked). Ceiling: 38–39 (coverage 40/40
in `coverage-study.md`, minus `sqrt` and `shortest_paths` where Jev's rank for the gold is poor). Cost
$0.005–0.01 and 10–30 s per program (§5.1), an order of magnitude under the brief's criterion.

What the prediction rests on, stage by stage: coverage 40/40 (F6) × localisation top-5 ∪ SBFL top-5 ≈ 38–39/40
(F3 + `lit-repair` §7 Ochiai ≤ 5: 34/38) × Noul top-3 contains the fix 39/40 (F4) × the test oracle. The
greedy-trap fix is the only part not backed by a direct measurement (beam of bases is inferred from the
three trap cases and the three genuine two-step repairs).

### 6.2 SWE-bench Verified, the 30 checked-in instances

| Stage | Measurement | Instances surviving |
| --- | --- | --- |
| Fix fully reachable by mutation d≤2 + donor ≤2-sub + templates | `coverage-study.md` headline: **9/30** (`django-15315`, `-15572`, `-16100`, `-15916`, `pytest-10051`, `pylint-4970`, `-6386`, `requests-1142`, `-2931`); 6/30 with ≤1-sub donors | 9 |
| Gold file ranked #1 by Q-L1 and touched function in Q-L3 top-5 and a fix line in Q-L4 top-5 (±3) | `probe-swebench-understanding.md` chained: 21/30; of the 9 above, `django-16100` (file #2) and `pylint-6386` (file #17) fail | 7 |
| Ranking among ~1,641 mutants + donors per anchor with the fix present | measured only at ≤ 934 candidates on 10-line programs (26/34 top-1, 31/34 top-5, `lit-repair` §7) and order-sensitive; **not measured on repository lines** | ×0.6–0.8 (assumed) → 4–6 |
| Multi-hunk: 5 of the 7 need 2–8 hunks (`-15572` 2, `-15916` 4, `pytest-10051` 2 incl. a new 3-line method, `requests-1142` 2, `requests-2931` 2); tests may pass with fewer hunks than gold | unmeasured; the outer loop's per-test decomposition and `extraEdits` reach depth 3 | ×0.5–0.8 → 2–5 |

**Prediction: 2–5 of 30 resolved (7–17 %), central 3**, at ≈ $0.05–0.25 of Jev per instance and 10–60 min of
mostly test time. The two single-hunk reachable-and-localised instances (`django-15315`: replace a 5-line
tuple hash by `return hash(self.creation_counter)`, a donor+1-sub line; `pylint-4970`: guard insertion
`if self.min_lines == 0: return`) are the ones the design should solve first; the remaining 21 instances are
out of reach *by proposal coverage* (new logic, new names, idiom changes: `coverage-study.md` groups 1–3) and
must be reported as such, not as ranking failures. For comparison the jev-on generator condition solved
9/29 (`docs/STATUS.md`). Any instance solved by a system with no generating model is the result the brief
asks for; three would already be that.

Assumptions the SWE prediction needs and that the bench must supply: the test patch is applied to the
workspace before the run (the FAIL_TO_PASS tests must exist for T0), the task text or the bench spec names
the FAIL_TO_PASS node ids (else T0 falls back to the test files matching the localiser's file beam), and the
repo's venv is on PATH (DESIGN §8).

---

## 7. Module list for implementation

Existing under `src/synth/` (untracked, unit-tested, measurement-cited in their headers): `py/` (tokenizer,
structure, edits, similarity), `sbfl/` (tracer, Ochiai, run), `localize/` (Q-L1–Q-L5, sites), `mutate/`
(27 operators), `templates/` (8 families), `donor/` (index, adapt, holes Q-H1), `beam/` (Q-B1–Q-B3), `rank/`
(Q-R1–Q-R3, detector), `verify/` (runners, progress, route, Q-P1–3, Q-T1, apply). This design adds the
composer and the pieces that only the composer needs:

| File | Responsibility | Measured basis / note |
| --- | --- | --- |
| `src/synth/search/index.ts` | `createRepairSearch(opts): Synthesizer` — the `synthesize(ctx)` of §1.2; phases A–D; returns the Proposal kinds of §4.1 | prototype `loop.mts` skeleton (F1) |
| `src/synth/search/memory.ts` | `SearchMemory` per run: bases beam (B = 2, depth ≤ 3), `tried` diff hashes, site/source cursors, budget used; `rebuildFromWindow(window, plan)` for `--resume` | §4.3 |
| `src/synth/search/oracle.ts` | detect the test oracle: QuixBugs runner (`index.json` + `run_tests.py`), pytest node ids from the task/spec, test files for the localiser's file beam, `workspaceInfo.testCommand`; T0/T1/T2 command builders | §3.3 |
| `src/synth/search/sites.ts` | work list from `LocalizeResult`: replace sites, insert gaps after/before top-3 anchors, `def`-line exclusion, evidence ordering; SBFL anchors 5 (single-file) / 3 | §1.4; F3 |
| `src/synth/search/sources.ts` | source order and gating (§2): mutation → templates → donor → second-order → beam; `fixProbablyAbsent` routing; vocabulary pre-filter; `tried` exclusion | F6, F7 |
| `src/synth/search/queue.ts` | global verification queue keyed by (base passed desc, Noul p desc); P_VERIFY = 0.5, top-3 fallback, insert-site top-3 rule; shuffle-and-average rerank for slow oracles | §3.1, §1.5 |
| `src/synth/search/scratch.ts` | scratch copies: QuixBugs candidate files; `git worktree` pool of P = 4 under `<workspace>/.jevcode-synth/<runId>/scratch/<k>`; `apply`, `reset`, `dispose`; all through `ctx.sandbox.run` | §3.2 |
| `src/synth/search/verify-parallel.ts` | run ≤ P candidates concurrently through `Verifier.runTests` in scratch; timeouts of §3.3; `Progress` per candidate; `route()` | F8, F2 |
| `src/synth/search/cluster.ts` | extra-input generation (perturbations of test inputs, code only), behaviour clustering, Q-V1/Q-V2 questions, `chooseWinner` | §3.4, **UNMEASURED**, behind a flag until the §8 experiment |
| `src/synth/search/budget.ts` | per-step caps (requests, runs, wall) and per-run totals; every Jev request and test run passes through it; abort-aware | §5 |
| `src/synth/search/proposal.ts` | build `Proposal`s of §4.1: goal text, `PlanDraft` from memory, unified diff via `verify/apply.ts`, P-DONE-FAIL summary; consume `ctx.directive` (§4.4) | DESIGN §6 |
| `src/synth/search/trace.ts` | `SearchTrace` (already in `types.ts`) → `synth` events per phase (`localise`, `enumerate`, `rank`, `verify`, `accept`), counts by source; transcript lines | `EngineEvent 'synth'` |
| `src/synth/index.ts` | replace the placeholder: `createSynthesizer(opts)` → `createRepairSearch` | DESIGN §21 |
| `src/synth/rank/index.ts` (small change) | SWE-bench chunk size 150 when the function listing exceeds ~4k tokens; expose `shuffleRerank(shortlist)` | §1.5 |
| `src/synth/localize/sites.ts` (small change) | insert gaps as first-class `Site`s with `kind: 'insert'` before/after each anchor; `sbflAnchors` option 5 for single-file | §1.4 |
| `test/unit/synth/search/*.test.ts` | memory rebuild from a window fixture; oracle detection on QuixBugs and pytest layouts; queue ordering; scratch apply/reset with a fake sandbox; budget stops; proposal kinds per phase; directive handling; cluster on synthetic outputs | offline, mocked `ask` |
| `test/live/synth-search.live.test.ts` | `gcd` and `wrap` end to end against live Jev with the QuixBugs runner (≤ $0.01) | – |
| `bench` suite `quixbugs` (`bench/data/quixbugs`) | 40 programs, jev-only condition, asserts zero generator tokens; reports repaired, correct-by-diff, requests, runs, cost, wall per program | §6.1 table is the expected output |

Contract change requested (not made here: `src/` is out of scope for this document): `SynthesisContext.runDir`
(absolute path of the run directory) so scratch copies live beside the checkpoints instead of inside the
workspace.

---

## 8. The three biggest risks, and the experiment that retires each

| # | Risk | Why it is the biggest | Experiment (script under `experiments/repair-search/`, cost) | Retires it if |
| --- | --- | --- | --- | --- |
| **R1** | **Ranking at repository scale.** Every ranking number is from ≤ 254 (once 934) candidates of 10-line programs with 3 JSON tests in the state. SWE-bench sites have a median of 1,641 first-order mutants plus donors, 30–80-character lines, a 25–175-line function listing and pytest failures as text; with 300 near-duplicates a reshuffle moved the gold's Noul from 0.48 to 0.14 (`lit-repair` verification). If the gold lands at Noul rank 30 among 1,600, the 12-run budget never reaches it and the design degrades to the 6–9/30 coverage ceiling × ~0. | It decides whether the SWE-bench prediction is 3 or 0, and whether chunked Nouls + Q-R3 is the right shape at all. | `rank-at-scale.mts`: the 9 coverage-reachable instances at `base_commit` (worktrees exist under `/tmp/jevonly/repos/`); enumerate real candidates at the gold anchor line with `src/synth/mutate`, `templates`, `donor` (cap 2,000), inject the gold hunk's line, rank with chunked compact Nouls (150 and 254 per chunk) + Q-R3, three shuffles each; report gold rank, max Noul, `fixProbablyAbsent`, tokens, cost, p50; also the 5 localised-but-wrong sites per instance without the gold (false-positive rate at p ≥ 0.5). 9 × 2 chunkings × 3 shuffles × ~11 chunks ≈ 600 requests ≈ **$0.15**. | gold in the Noul top-5 on ≥ 6/9 with median max-Noul ≥ 0.5, and ≤ 1 false-positive candidate at p ≥ 0.5 per wrong site. Otherwise: add a code-side pre-filter (SimFix-style similarity to the buggy line, top-300) and re-measure; or restrict SWE-bench sites to donors + templates only. |
| **R2** | **The acceptance policy: beam of bases and the overfitting guard.** The greedy trap cost 3 of 8 failures (two runs) and the beam-of-bases remedy is inferred, not measured; the cluster guard (Q-V1, Q-V2, perturbed inputs) has never been asked, and the literature says 53 % of plausible patches overfit. A wrong beam policy can lose the 3 genuine two-step repairs; a wrong guard can reject correct fixes (`next_permutation`, `max_sublist_sum` equivalents) or accept `depth_first_search`'s. | It sets the correct-by-inspection rate, which is the number that matters, and the QuixBugs prediction's 34–36 band depends on it. | `beam-and-guard.mts`: the prototype loop with (a) Noul ranking + unchanged line removed, (b) B ∈ {1 (greedy), 2}, (c) guard off / on; 40 programs × 2 seeds; per program: repaired, gold-equal, passes-all-upstream-tests-plus-10-held-out (the QuixBugs slow cases and hand-written extra inputs as held-out), runs, requests, cost; the 13 partial candidates of `experiments/progress/candidates.json` as the trap set. ≈ 40 × 4 configs × 2 seeds × ~8 requests ≈ 2,600 requests ≈ **$0.30**. | B = 2 repairs ≥ 34/40 in both seeds and loses none of the 30 both-run prototype repairs; the guard rejects the `depth_first_search` overfit and keeps both equivalents, with Q-V1 ≥ 0.5 on ≥ 90 % of gold fixes. Otherwise: keep B = 2 without the Jev guard and use behavioural clustering alone (code only), or drop the guard and report the overfit rate. |
| **R3** | **Insertions and multi-hunk reach.** Insert sites are the weakest measured link: neighbours localised at ranks 2–5, gold statements at Noul p 0.33–0.39 for `shunting_yard`/`wrap`, a compilable pool of 300–700 statements per gap, and `shunting_yard`'s gap is invisible to SBFL. On SWE-bench 121/199 fixed lines are insertions and 19/30 gold patches have ≥ 2 hunks; whether the per-test decomposition finds a second hunk from a partial base, and whether FAIL_TO_PASS passes without every gold hunk, is unmeasured. | It is the difference between the 32/40 skeleton and the 35+/40 prediction on QuixBugs, and it bounds everything multi-hunk on the ladder and SWE-bench. | (a) `insert-e2e.mts`: the 4 QuixBugs insertion programs end to end with gap sites after the top-3 anchors, templates + donors, chunked Nouls, ≤ 12 runs; 3 seeds; ≈ **$0.02**. (b) `hunk-subsets.py` (code only, **$0**): for the 9 reachable SWE instances apply every subset of gold code hunks in a worktree and run FAIL_TO_PASS + PASS_TO_PASS; record the minimal passing subset, which tells the loop how many hunks the tests actually demand. (c) `ladder-two-edit.mts`: the `bench/data/ladder` two-coordinated-edit tasks with B = 2, depth 3; does the second base's re-localisation (diff in the state) put the second site top-3; ≈ **$0.05**. | (a) ≥ 3/4 repaired with the gold statement in ≥ 2 seeds; (b) ≥ 4 of 9 instances pass with ≤ 2 hunks; (c) second site top-3 on ≥ 2/3 tasks. Otherwise: for insertions ask Q-I1 with each template statement and enumerate only its placement; for multi-hunk, accept that v1 handles single-hunk plus `extraEdits` and report the rest as out of scope. |

Two smaller risks worth a line: the `--resume` rebuild from the window depends on the runner's JSON line
surviving the 600-char window truncation (put it at the tail; the window keeps the tail); and the sandbox
profile must allow `git worktree add` under the workspace (`.git` writes are denied for `config`/hooks only,
DESIGN §8; a unit test with the real profile should confirm `worktrees/` is writable).

---

## 9. What this means for the design (summary)

1. The engine is the prototype's loop with five measured corrections: Noul ranking in ≤ 254-chunks with the
   unchanged line removed (F4, F5), a beam of two bases instead of greedy commitment (F2), insertion gaps as
   first-class sites with templates and donors (F6, F9), SBFL top-5 unioned into localisation (F3), and
   `fixProbablyAbsent` as the switch between sources before any test run (F7). Each correction is tied to a
   named prototype failure and a probe number; together they are worth +3 to +5 programs on QuixBugs.
2. Tests stay the only oracle; Jev's job is to make test runs few (prototype: 10 per program with Choice
   ranking; the Noul rerank should bring the typical case to 1–3) and to order sites. Progress and routing are
   code (F8). The one place Jev is asked to judge correctness (the cluster guard) is unmeasured and gated.
3. Generation by Choices is the sixth source, not the engine: on QuixBugs it never reaches a line the mutation
   catalogue does not, and on SWE-bench the lines it would need to build are exactly the ones whose tokens are
   absent from the file (`coverage-study.md` group 2), so its expected marginal value is small until a name
   source (issue text, API surface) exists.
4. Honest reach: QuixBugs 34–36/40 at ≈ $0.006 and ≈ 20 s per program; SWE-bench 2–5/30, with two-thirds of
   the slice unreachable by construction and reported as such. The three experiments in §8 (≈ $0.55 total)
   decide whether the SWE number is 3 or 0, whether the correct-by-inspection rate tracks the repaired rate,
   and whether insertions and second hunks are in reach.
