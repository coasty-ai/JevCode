# Grammar synthesis: a Jev-only synthesis engine designed synthesis-first

Design note, 2026-09-20. Angle: build the fix as a **sketch beam**, a sequence of Jev Choices over grammar
productions (shapes with typed holes) and in-scope identifiers (slot fills), beam-searched and pruned by
tests; mutation operators, fix templates and donor lines enter the same beam as *seeds* (fully or partly
instantiated hypotheses). The optimisation target is **reach**: fixes that need tokens the buggy line does
not have (fragments, wraps, guards) and fixes that need a new line.

Every number below is from a file in `experiments/results/` (cited by name) or from the pilot run for this
note (`experiments/grammar-synthesis/`, Appendix A, live spend **$0.037**, 120 requests). Nothing under
`src/` or `docs/` was changed.

Verdict in one paragraph. The sketch stage works as a **reach** layer: a code-built pool of a median 64
sketches contains a shape the gold line instantiates on 39/40 QuixBugs programs, insertions included
(Appendix A, only the two-edit `shortest_paths` is out), and Jev picks that shape top-1 on 23–26/40, top-3
on 29–31/40 (three runs). It is **not** a precision layer: the misses are exactly the "one token deep"
additive fixes (`- 1`, `** 2`, an attribute name) where holes hide the evidence Jev needs, and those are the
programs the *concrete* candidate route already handles (probe-selection.md: Noul top-3 39/40 at N ≤ 254;
prototype-baseline.md: 32/40 end to end). So the engine below runs one beam whose complete (hole-free)
hypotheses are tested first, whose holed hypotheses are filled by slot Choices (lit-guided-synthesis.md: 92 %
of lines at B = 3 given the shape), and whose fallback is the open token beam (probe-token-synthesis.md:
20/40 lines). The measured pieces compose to a predicted **35 ± 2 / 40 on QuixBugs** and **2–4 / 30 on the
SWE-bench slice** (§6, with the arithmetic).

## 0. Evidence this design rests on

| Fact used below | Number | File |
| --- | --- | --- |
| Line localisation, Choice over lines with tests **and the buggy program's actual output** | top-1 28/40, top-3 36/40, MRR 0.805; D ∪ Noul-per-line top-3 covers 38/40 | probe-localization.md §1, §3 |
| The 11 programs no line variant gets top-1 | 4 insertions + 7 "innocent-looking" lines (`lis`, `mergesort`, `possible_change`, `subsequences`, `longest_common_subsequence`, `detect_cycle`, `shortest_path_length`) | probe-localization.md §5 |
| Repo-scale file localisation from the issue text, Nouls over every source path | gold #1 23/30, ≤5 28/30, ≤10 30/30, $0.0011 per instance; function top-5 35/37; line ±3 top-5 94 % (80 % when escape-dominated rows count as misses); chained 21/30 | probe-swebench-understanding.md headline, caveats |
| Concrete candidate ranking, one compact Noul per candidate | top-1 39/37/32/32 and top-3 40/40/38/36 at N = 10/50/150/254; flat Choice 36/31/29/26; two-stage 33/40 with the fix shortlisted 39/40 | probe-selection.md summary |
| Fix-absent signal on a Choice | `P(escape) − p_max ≥ 0.10`, AUROC 0.916, 82 % detection, 13 % false alarm | probe-selection.md detector |
| Drop the unchanged line from candidate options | 19/20 top-1, **20/20 test-passing top pick**, 0 confident misses | probe-question-design.md §5, §6 |
| Candidate text in descriptions, JSON not prose, no docstring, opaque keys + descriptions fine, code-slug keys worse | `Sc_string` 11/20; `Lf_docstring` 14.25/20; `Sb_semantic` 16.75 vs 17.75 | probe-question-design.md §3 |
| Slot filling on a known shape, prefix mode, beam in one request | slots 90–93 % top-1 (156 slots, 100 % option coverage); S2 diff-fill 92 % (23/25) at B = 3, S1 full-fill 76–83 %; 1.7 (S2) / 5.4 (S1) requests per line; $0.00012 per request | lit-guided-synthesis.md §5 |
| Open token beam with a code grammar filter | W = 3 + grammar 20/40 any-of-top-3 passes, $0.0037 and 3.3 s per line; teacher-forced 84 % / 96 %; p(top) ≥ 0.9 right 99 % | probe-token-synthesis.md §2–3 |
| Portfolio of synthesis routes with tests as oracle | 27–28/40 lines (union over single runs; not confirmed as one pipeline) | probe-token-synthesis.md §7.2 |
| Donor line at a hole among ≤ 254 lines; identifier hole filling | 35/36, 33/36, 32/36; changed identifier 13/13 (leak-free) | probe-donor-and-templates.md headline |
| Insertion point given the statement / unknown | 4/4 / 2/4 | probe-donor-and-templates.md (4) |
| Mutation-library coverage of QuixBugs fixes; SWE-bench reach | QuixBugs 40/40 (union), 38/40 first-order; SWE 6/30 (9/30 with 2-sub donors), 57/106 hunks, vocabulary ceiling 15/30, 19/30 need 2+ hunks, median 1,641 depth-1 mutants per SWE line (3 % ≤ 255) | coverage-study.md headline, per-instance rows |
| Prototype loop (localise → mutate → Choice → test top-5 → adopt strict improvement) | 32/40 (31 correct), $0.035 total, 5.3 requests and 10.3 test runs per program; all 8 failures hit the 40-test-run cap; greedy-progress trap cost 2–3 programs; winners' median p 0.79 | prototype-baseline.md |
| Progress from test results | with code-computed counts + failure texts the three Nouls are 240/240; code routing 240/240; never ask Jev to compare numbers | probe-progress-judgment.md |
| Jev operating envelope | ~170–250 ms per request independent of question count, $0.042/M input tokens, 128-way concurrency, 255 options, 32k-token state cap, ±0.02 noise in the 0.55–0.80 band, positional arithmetic weak, escape options needed | REPORT.md §5–§10, §14 |
| **Sketch Choice (this note)** | coverage 39/40; top-1 23/23/26, top-3 29/29/31, top-5 33/32/33 over three runs; edit-class Choice 28/29/24 top-1, 36/35/36 top-2; $0.00019 per program, p50 238–243 ms | Appendix A |

## 1. The algorithm

### 1.1 Objects

```
Site        = { file, line, kind: 'replace' | 'insert', currentLine, indent, block, scope, evidence }   (src/synth/types.ts)
Hypothesis  = { site, toks: Tok[], holes: HoleIdx[], provenance: 'seed:mutation' | 'seed:template' | 'seed:donor' | 'sketch:<production>' | 'fill' | 'token_beam',
                depth, logP, extraEdits?: LineEdit[] }          -- a complete hypothesis has holes = []
Base        = { files: Map<path, src>, tests: TestRunSummary }   -- a program state; the loop keeps ≤ 2 bases (prototype lesson)
Hole classes: `_`  one identifier / number / string / True|False|None ;  `<op>` one operator
```

A sketch is a `Hypothesis` with holes; a candidate is a complete hypothesis. The three measured routes are
one object seen at different depths: a mutation candidate is a depth-1 complete hypothesis (production applied
and hole filled by the operator table in code), a sketch is a depth-1 holed hypothesis (production applied,
holes left for Jev), a token-beam line is a hypothesis grown from the empty prefix with the open grammar.

### 1.2 One synthesis step (pseudo-code)

```
synthesize(ctx):                                        # returns exactly one Proposal (§4)
  base      ← current program state (ctx.workspace) ; before ← runTests(base, selection = failing-first)   # code
  if before.allPass: return propose_done_or_run(...)   # §4.5
  sites     ← localise(ctx, before)                    # §1.3: Q-FILE, Q-CONFIRM, Q-FN, Q-LINE, Q-GAP → ≤ 3 sites (+1 insert gap each)
  for site in sites (best first), while budget:
      # --- Round 0: complete seeds (precision layer) ------------------------------------------------
      seeds     ← mutate(site) ∪ templates(site) ∪ donors(site, ≤1 sub)          # code; compile-filter; drop the unchanged line
      ranked    ← Q-RANK(seeds)                                                    # Nouls per candidate (+ Choice over top-5)
      tested    ← verify(top-3 of ranked)                                          # §3
      if any allPass → accept (§4.4) ; if any improved-without-regression → keep as second base
      absent    ← ranked.fixProbablyAbsent (P(escape) − p_max ≥ 0.10 or max Noul < 0.5)
      # --- Round 1: sketch layer (reach layer) ----------------------------------------------------
      pool      ← productions(site)                                                # §1.4; median 64, cap 254; never includes the unchanged line's shape with 0 holes
      { sketch, edit_class } ← Q-SKETCH + Q-EDIT-CLASS (one request)
      K         ← 3 ;  if P(top) < 0.5 or P(escape) ≥ 0.3: K ← 5                  # Appendix A: 13/40 low-confidence, only 4 of them top-3
      keep      ← top-K sketches by P, reordered so sketches consistent with the top-2 edit classes come first (soft prior, never a filter)
      # --- Round 2: slot filling beam ---------------------------------------------------------------
      for depth d = 1..maxHoles(keep):                                             # ≤ 12; one request per depth for ALL kept sketches × B beam items
          Q-SLOT for every live (sketch, beam item) at its d-th hole, prefix mode, options = vocab(site, hole class)
          expand 1 option when p(top) ≥ 0.9 else B = 3 ; compile-filter partial lines ; keep B per sketch by Σ log p
      lines     ← complete hypotheses from keep, deduped against `tested`
      ranked    ← Q-RANK(lines ∪ untested seeds top-10)                            # concrete again: Nouls see the tokens
      tested    ← verify(top-3)  ; accept / second base as above
      # --- Round 3: open token beam (fallback) -------------------------------------------------------
      if nothing improved and budget.requests ≥ 35:
          lines ← TOKEN-BEAM(site, W = 3, grammar filter, ≤ 25 tokens)           # Q-NEXT-TOKEN per depth, all beams in one request
          tested ← verify(top-3 distinct completions)
      # --- Round 4: widen ----------------------------------------------------------------------------
      if nothing improved: next site ; when sites are exhausted: Q-GAP insert gaps around the top lines, then all lines of the function by combined Jev+Ochiai score
  return proposal(best tested hypothesis, trace)       # §4
```

Round 0 runs before the sketch rounds not because sketches are less important but because a complete
hypothesis can be tested immediately and the concrete tokens carry the evidence Jev ranks well
(probe-selection.md Noul top-3 39/40 vs Appendix A sketch top-3 29/40): test pruning is cheapest on the
hypotheses that need no Jev fill. The sketch rounds then spend Jev only on shapes the seeds did not
reach (insertions, wraps, fragments with non-trivial operands), which is where the reach comes from.

### 1.3 Every Jev question, its type, option construction and consumption

All questions go through `src/jev/questions.ts` (`choice()` adds `none_of_these`; `noul()` demands both
criteria sides; `contextNoul()` for criteria-once-in-state batches), are asked through `ctx.ask` so they land
in `decisions.jsonl`, and follow REPORT §14: backticked paths, no counting, thresholds from the measured
plots (0.7 Choice / 0.5 Noul / 0.9 "trust").

| Id | Type | State (code-built) | Instructions (verbatim) and option set | Consumed as | Measured |
| --- | --- | --- | --- | --- | --- |
| **Q-FILE** | Nouls, ≤ 250 per request, batched concurrently | `{ issue: task, criteria: { yes_when, no_when }, files: [paths] }` | "Must the file `<path>` (listed in `files`) be modified to fix `issue`? Apply `criteria`." | rank by p; **beam of top-5**, never a threshold (P at 0.5 is 0.54) | Q6: #1 23/30, ≤5 28/30 |
| **Q-CONFIRM** | Nouls over the top-5–10 files with `top_level_symbols` outlines | `files: { path: { top_level_symbols } }` | "Must the file `files["<path>"]` be modified to fix `issue`? Answer yes only if the code change that fixes the issue lands in this file." + definition/examples criteria | re-rank; keep top-5 | Q3 outline 31/33 gold-first vs 28/33 paths |
| **Q-FN** | Choice per beam file over its defs (+ `module_level_code_outside_any_function`) | `file.functions: { key: "method X.y, line N: def ..." }` | "`file` is the source file that must be edited to fix `issue`. Which entry of `file.functions` must be modified (its body changed, or new code inserted directly into it)…" | global top-5 by P(file) × P(fn) | top-5 35/37, top-1 19/37 |
| **Q-LINE** | Choice over the function's code lines (variant D) | `{ task, program: { L<k>: text }, tests: [{input, expected}], failing_test_run: { input, expected, actual } }`; option key `line_<k>`, description = line text; **the state key and option key share the number** | "Which line of `program` contains the bug? Pick the single line that must change so that the function is correct. Choose `none_of_these` only if no listed line is faulty." | top-3 anchors (all with P ≥ 0.10, ≤ 5) → ±3-line windows → Sites; P(top) ≥ 0.9 → try that line alone first (92 % right); escape falls through to the ranking, never stops | 28/40, 36/40; ±3 top-5 94 % on SWE functions |
| **Q-LINE-NOUL** | Noul per line, criteria definition + examples, same state | id `line_<k>` | "Is line `program.L<k>` the line that must change to fix the bug in `<fn>`? Judge this line only; other lines are judged separately." | union its top-3 with Q-LINE's (covers 38/40); 0 lines at p ≥ 0.5 → widen to insert gaps; exactly one at p ≥ 0.9 → short-circuit | C 24/40; lit-line signal §8.3 |
| **Q-GAP** | Choice over gaps `before_l1`, `after_l<i>` | state adds `missing_statement` when a candidate statement exists | "Where in `program` must `missing_statement` be inserted so that all `tests` pass?" | top-2 gaps become insert Sites | 4/4 given, 2/4 unknown |
| **Q-RANK** (concrete) | N ≤ 10: Choice; 10 < N ≤ 60: Choice + compact Noul per candidate in one request, ranked by Nouls; N > 60: compact Nouls in chunks ≤ 254 then Choice over the Noul top-5 | `{ task, program, buggy_line_number, buggy_line, tests[≤3, failing first, with actual_with_bug], candidates: { cand_xx: text }, correct_fix_criteria }`; unchanged line never an option; duplicates folded | Choice: "Which option is the corrected line that, put in place of `buggy_line`, makes every test in `tests` pass, including the tests that currently fail? Read each option literally… Choose `none_of_these` if no option is a correct fix." Noul: "Is `candidates.cand_xx` the corrected line: put in place of `buggy_line`, does it make every test in `tests` pass?" | order of test runs; `fixProbablyAbsent` = `P(escape) − p_max ≥ 0.10` (Choice) or `max Noul < 0.5` → advance a round without more test runs on this set | 39/40 top-3 at every N; two-stage 33/40 top-1 |
| **Q-SKETCH** | Choice over ≤ 254 sketches, opaque keys `sketch_aa…`, description `{ shape, change }` | `{ task, program (site marked `<<<FIX THIS LINE>>>`), buggy_line, tests }` | "Each option is a sketch of the corrected line for the `<<<FIX THIS LINE>>>` marker in `program`. In a sketch, `_` stands for one identifier, number, string or True/False/None still to be chosen, `<op>` stands for one operator still to be chosen, and every other token is shown literally. Which sketch is the shape of the correct replacement line, so that with the right tokens in its holes every entry of `tests` passes? Read the sketches literally and compare them with `buggy_line`. Choose `none_of_these` if no listed sketch fits the correct line." | keep top-K (K = 3; 5 when P(top) < 0.5 or P(escape) ≥ 0.3); escape never stops the search | **Appendix A**: cov 39/40, top-1 23–26, top-3 29–31, top-5 32–33 |
| **Q-EDIT-CLASS** | Choice over 6 edit classes with definition + two examples each | same request as Q-SKETCH | "Which kind of edit turns `buggy_line` into the correct line for the `<<<FIX THIS LINE>>>` marker in `program`, so that every entry of `tests` passes? Judge the edit that would be written. Answer carefully and literally." Options `substitute_one_token`, `insert_fragment`, `delete_fragment`, `reorder_tokens`, `reshape_line`, `insert_new_line` | **soft prior only**: sketches whose production belongs to the top-2 classes are ordered first within the kept set; never used to prune (probe-donor §3: never gate on kind) | 28–29/40 top-1, 35–36/40 top-2 (Appendix A); kind-with-line 30/40 (probe-donor 3c) |
| **Q-SLOT** | Choice per hole, B beam items per request as independent questions | `{ …, hypotheses: { first: "return kth(above, k <op> ?)", second: … } }` with `<HOLE>` at the hole and `?` for later holes; options = identifiers with roles (≤ 60) / attributes seen on the receiver (≤ 40) / 24 operators / literals from tests and file (≤ 30), keys `name_<id>`, `op_plus`, `num_2`, `attr_append` | "`hypotheses.first` is a partially written replacement for `buggy_line` in `program`. Tokens before `<HOLE>` are fixed; each `?` is a token still to be filled in later. Which option is the correct token for `<HOLE>`, so that the finished line makes every entry of `tests` pass? Pick `none_of_these` if no option fits." | beam: expand 1 when p(top) ≥ 0.9 else B = 3; Σ log p orders, tests decide; same-class identifier pairs (`i`/`j`, `a`/`b`) are permuted in code (probe-donor §6) | slots 90–93 % top-1; S2 92 %, S1 76–83 % |
| **Q-NEXT-TOKEN** | Choice over grammar-legal next tokens (~60 after the filter) + `end_of_line`, W beams per request | `{ task, program (marked), buggy_line, tests, partial_line, partial_tokens }` | "`partial_line` is the beginning of the correct replacement line for the `<<<FIX THIS LINE>>>` marker in `program`… Which single Python token comes immediately next in the correct line? Choose `end_of_line` if `partial_line` is already the complete correct line. Choose `none_of_these` if the next token is not offered. Answer literally: exactly one token, not a whole expression." | W = 3; `end_of_line` legality decided by code; verify top-3 distinct completions | 20/40, $0.0037/line |
| **Q-DONOR** | Choice over donor lines (own file, then package, then repo; ≤ 254, shape-indexed) | `{ task, program with `<<< MISSING LINE >>>`, missing_line, tests }`, options = whitespace-stripped lines | "Which candidate line, adapted to the identifiers of `program`, belongs at `program.L<k>` (the `<<< MISSING LINE >>>` marker) so that all `tests` pass?" | top-3 donors become holed hypotheses (foreign identifiers → `_`) for Round 2; `top ∈ {escape, buggy line}` = "no donor here" (35/36 recall) | 35/36, 33/36, 32/36 |
| **Q-HOLE-IDENT** | Choice per identifier hole of a donor, one template per request (leak) | `{ task, program, faulty_line, tests, replacement_templates: { hole_k } }` | "Which identifier, in scope in `program`, fills `__HOLE__` in `replacement_templates.hole_k` so that the completed line at `program.L<k>` makes all `tests` pass?" | subsumed by Q-SLOT in the beam (same measured shape); kept for donors with > 6 holes | 13/13 |
| **Q-GENUINE** | Noul after a candidate passes every selected test | `{ task, failing_before: [{input, expected, actual}], diff, tests_after: { passed, failed, total }, candidate }` | "Given `failing_before` and `diff`, does `candidate` fix the cause of the failure, rather than only making the listed tests pass?" true: "the change corrects the operator, bound, argument, guard or statement that produced `actual`, and would hold for inputs like the tests"; false: "the change special-cases the tests' inputs, deletes the behaviour under test, or changes an unrelated part" (≥ 2 examples each) | ≥ 0.7 → accept; < 0.3 → keep searching one more round and prefer another passing cluster; between → accept but record `unverified` | **unmeasured**; risk 3 |
| **Q-CLUSTER** | Choice over behaviour clusters when ≥ 2 candidates pass | `{ task, tests, clusters: { cluster_a: { representative_line, outputs_on_extra_inputs } } }` | "Which cluster's representative is the correct fix? Each cluster's members produce identical outputs on `extra_inputs`." | pick cluster; tie → smallest diff | **unmeasured**; risk 3 |
| **progress** | none | — | — | code: `after.failed == 0`, `newly_failing.length > 0`, `after.passed > before.passed` (probe-progress: Nouls are pure functions of these numbers; 240/240 routed in code) | — |

Not asked anywhere: "how many", "which is longer", "is X within 1 %" (REPORT §10); the change-kind of a whole
task as a gate (probe-donor §3, probe-swebench §6: 53–62 %); the next move as a free policy Choice
(probe-progress: 4/10 on partials).

### 1.4 Productions (code proposes the sketch pool)

Applied to the tokenised current line `B` (n tokens) of a replace site; each yields one sketch and a
`change` description that goes into the option description. Measured pool: median 64, max 138, never
capped at 254; 39/40 gold lines instantiate a pool sketch (Appendix A, offline).

| # | Production | Where it applies | Holes | QuixBugs gold sketches it produced (Appendix A) |
| --- | --- | --- | --- | --- |
| P1 | `hole_at_token`: one identifier/number/string/literal → `_`, one operator → `<op>` | every such token | 1 | 10 substitutions (`while _:`, `while lo <op> hi:`, `enumerate(_)`, `nextnode._` …) |
| P2 | `operator_and_operand`: `op X` → `<op> _` | binary op followed by a name/literal | 2 | `if len(arr) <op> _:` (`== 0` → `<= 1`) |
| P3 | `fragment_after_value` from the table {`<op> _`, `[_]`, `[_:]`, `[:_]`, `[_:_]`, `or _`, `or not _`, `and _`, `and not _`, `or _ is None`} | after a value token; boolean fragments only at bracket depth 0 in a header or `return` | 1–2 | `mid <op> _`, `k <op> _`, `j <op> _`, `r <op> _`, `approx <op> _`, `arr[_:]`, `b[_:]`, `or not _` (8 lines) |
| P4 | `fragment_before_value` {`_ <op>`, `not`, `_ is None or`, `_ is not None and`} | at an operand start | 1 | `return _ <op>[…]`, `if _ is None or hare…` (2) |
| P5 | `wrap_span`: `_(span)`, `_(_, span)`, `_(span, _)` | maximal operand spans and the whole RHS | 1–2 | `_(_, length + 1)`, `_(_, max_ending_here + x)`, `if _(n % p …)` (3) |
| P6 | deletions: `X op` / `op X` pair, unwrap `f(x)` → `x`, drop `not`, drop redundant parens | grammatical positions | 0 | `yield x`, `return levenshtein(…)` (2) |
| P7 | swaps: adjacent arguments/elements in `(…)`/`[…]`, operands around a binary operator | every bracket group, every binary op | 0 | `gcd(b, a % b)`, `op(token, b, a)`, `perm[i] < perm[j]`, `[k, j]`, `alphabet[i] + result` (5) |
| P8 | `expression_to_hole`: a call or subscript span → `_` | multi-token operand spans | 1 | `_ + length_by_edge[…]` (1) |
| P9 | `method_call_to_assignment`: `X.m(Y)` → `X = Y` | statement-level method call | 0 | `group_by_node[node] = group_by_node[u]` (1) |
| P10 | RHS templates for `return`/`yield`/assignment: `_`, `_ <op> _`, `[_]`, `[[]]`, `[]`, `_(_)`, `_(_, _)`, `not _`, `_[_]`, `None` | statements with a RHS | 0–3 | `return _ <op> _`, `return [_]`, `return [[]]` (3) |
| P11 | insertion statement templates at a gap: `_._(_)`, `_ = _`, `_ = _ <op> _`, `_._()`, `return _`, `_ += _`, `if _:`, `continue`, `break`, `_ = _._`, `_._ = _` plus the abstracted shapes of the function's own lines | insert sites | 1–3 | `_._(_)` ×3, `_ = _` (4/4, all top-1 at P 0.75–0.92) |
| P12 | two-line guard: `if _ <op> _:` + `return _` / `raise _` / `continue` (TBar FP2/FP4, coverage-study `guard_insertion` 3 SWE hunks, 2 reachable only by templates) | insert sites | 2–3 | none on QuixBugs; SWE `pylint-4970`, `requests-2931`, `sympy-17139` |
| P13 | donor shapes: lines of the file/repo with the same statement kind, identifiers abstracted, ≤ 20 nearest by normalised-token similarity | replace and insert sites | k | probe-tokens template route: 4 of 17 covered templates were donors; SWE inserted lines 58 % donor+≤2 sub |

Ordering inside the pool (only matters for the 254 cap, which never fired on QuixBugs; SWE lines of 20–40
tokens will hit it): P1, P7, P3 `<op> _` at the end of the line, P5, P2, P6, P10, remaining P3/P4 by position
(end of line first), P8, P9, P13. Depth-2 compositions (P1∘P6, P2∘P7) are generated only when Round 0 and the
depth-1 pool both fail and `fixProbablyAbsent` fired twice (`shortest_paths` is the one QuixBugs line that
needs them; coverage-study.md: depth-2 adds 2/40 QuixBugs lines and 0 SWE hunks).

### 1.5 Scoring and pruning inside the beam

- Sketch score = P from Q-SKETCH; kept set K = 3 or 5 (Appendix A: P(top) ≥ 0.5 → top-1 right 21/27 and top-3
  25/27; P(top) < 0.5 → top-3 only 4/13, so widen and let tests decide rather than trust the order).
- Slot score = Σ log p over holes (ordering only). Expand 1 option when p(top) ≥ 0.9 (probe-tokens T2: 99 %
  right), else B = 3. Partial lines are compile-checked with holes replaced by a dummy name (PICARD-style
  "parsing without guards", lit-guided-synthesis §3.5).
- Complete lines are re-ranked concretely by Q-RANK before any test run: Σ log p prefers short lines and Jev's
  stop signal is unreliable (probe-tokens §7.4), while Nouls over concrete lines hold 98 % top-1 to 50 candidates.
- Test pruning: top-3 of every concrete ranking (probe-selection: fix within the Noul top-3 39/40; prototype:
  22/32 repairs needed exactly one verification). A candidate with `P < 0.05` is never run unless the round has
  produced nothing else (prototype §3: spend Jev instead of tests).
- Duplicates are folded before ranking (REPORT §7: identical descriptions split the mass) and every tested line
  is remembered per base so no line is ever run twice.

## 2. Candidate sources and their order

| Order | Source (module) | Enters the beam as | Why this position (measurement) |
| --- | --- | --- | --- |
| 1 | Mutation operators (`src/synth/mutate/`), first order, cap 200 per line, the unchanged line excluded | complete seeds | gold is a first-order mutant on 38/40 QuixBugs lines (probe-selection.md); median 137–225 compiling candidates (prototype, coverage-study); Noul ranking top-3 39/40; 80 % end to end alone (prototype) |
| 2 | Fix templates (`src/synth/templates/`): guards, missing statement, wrap, condition extension, signature, attribute, import, branch clone | complete seeds (multi-line via `extraEdits`) | TBar catalogue (lit-search-based-repair §1, §8); on SWE-bench `guard_insertion`, `add_parameter_default`, `add_branch_copy` are the only templates that reach hunks nothing else reaches (coverage-study templates table) |
| 3 | Donor lines with ≤ 1 substitution (`src/synth/donor/`), own function → file → repo, shape index | complete seeds; ≥ 2 substitutions → holed hypotheses | plastic surgery: 48 % of SWE inserted lines are a repo line with ≤ 1 sub, 58 % with ≤ 2 (coverage-study); selection 35/36 given the pool (probe-donor) |
| 4 | Sketch productions P1–P13 (`src/synth/sketch/`) | holed hypotheses | 39/40 shape coverage incl. insertions (Appendix A); the reach layer |
| 5 | Slot vocabulary (`src/synth/beam/vocab.ts`): in-scope identifiers with roles, receiver attributes, operators, literals from tests and file, common methods | fills | 100 % option coverage on 156 slots (lit-guided-synthesis) and 386/386 tokens (probe-tokens) |
| 6 | Open token beam (`src/synth/beam/beam.ts` + `grammar.ts`) | hypotheses grown from the empty prefix | 20/40 alone, solves lines no template or mutant reaches (`longest_common_subsequence`, `pascal` in probe-tokens §6) |
| 7 | Test-derived values: expected literals, expected types, exception names from the failing assertion | literals in the slot vocabulary and constant-substitution pool | in the operator library already (prototype "constant substitution from program and test literals"); numbers slot class 24/24 (lit-guided-synthesis) |
| 8 | Task-text names (SWE only): identifiers and quoted words in `problem_statement` | slot vocabulary extension for new names | coverage-study §4: 5/21 template matches fail only because a slot name is absent from file+tests (`exclude`, `metavar`, `saferepr`) |
| 9 | Repository history (`git log -S<symbol>`) | donor lines | not measured; cheap; last |

The **unchanged line is never a candidate** (probe-question-design: 20/20 test-passing top pick once removed);
"is the current line right" is carried by `fixProbablyAbsent` and, for donors, by `top ∈ {escape, buggy line}`.

## 3. Verification strategy

- **Oracle.** Tests only; Jev never marks a fix correct (JEV-ONLY.md non-negotiable 2). Progress is computed in
  code: `passed/failed/total`, `newly_passing`, `newly_failing`, failure texts; the three progress Nouls are
  not asked (probe-progress: they are functions of those numbers; code routing 240/240).
- **Test selection per run**, in code (`verify/select.ts`): (1) the failing tests at the base (QuixBugs: the
  JSON cases that fail; pytest: `FAIL_TO_PASS`-style node ids from the baseline run's short summary); (2) the
  rest of the same test module; (3) the full suite only for the accept step of a candidate that passed (1) and
  (2). A candidate that fails any test in (1) is dropped after (1): QuixBugs candidates run all 3–14 cases in one
  process anyway; pytest runs (1) with `-x -q -p no:cacheprovider`.
- **Runs per round: 3** (the concrete Noul top-3). Per site ≤ 4 rounds (seeds, sketch fills, token beam,
  widened), per step ≤ 3 sites: **≤ 36 test runs, default budget 24**, because the prototype's binding
  resource was test runs (all 8 failures hit the 40-run cap while using ≤ 14 of 30 Jev requests). Jev requests
  per step ≤ 60 (§5).
- **Parallelism.** Each candidate is applied to its own scratch copy of the touched files under the run dir
  (`verify/apply.ts` is pure) and run through `ctx.sandbox.run` with `PYTHONDONTWRITEBYTECODE=1` and a fresh
  directory per candidate (probe-question-design §8: a stale `.pyc` made the gold "fail" on 5 programs).
  Concurrency 4 for QuixBugs-size suites (0.2–1 s each), 2 for pytest modules (the sandbox serialises on the
  workspace otherwise). Jev requests for the next round are issued while the current round's tests run.
- **Timeouts.** QuixBugs: 2 s per case via the runner's alarm (upstream slow cases skipped as QuixBugs does;
  prototype §1). pytest: `min(ctx.limits.commandTimeoutMs, 3 × baseline duration + 10 s)`; a timeout counts
  as a failure of every unfinished test and the candidate is dropped (an infinite loop is the commonest wrong
  candidate: probe-tokens §3, 40 s outliers).
- **Acceptance.** `allPass` on selections (1)+(2) → run (3) → if still `allPass`, Q-GENUINE; ≥ 0.7 accept;
  when ≥ 2 candidates pass, cluster them by outputs on 5–10 generated inputs (permuted test inputs, boundary
  values 0/1/−1/empty from the test literals) and ask Q-CLUSTER only if clusters differ (AlphaCode's filter,
  lit-guided-synthesis row 10). A partial improvement (`newly_passing > 0`, `newly_failing == 0`) is kept as a
  **second base**, not adopted (prototype §"Progress rounds": adopting cost `kth`, `sqrt`, `topological_ordering`);
  the round-1 queue is finished first; `partial_mixed` (some newly failing) is always reverted
  (`verify/progress.ts` `REGRESSION_RULE`).

## 4. Plugging into the outer loop

The engine already runs intent → context → propose → risk → execute → judge → complete, with replan on loop
trips (DESIGN.md §6); in `jev-only` mode propose calls `Synthesizer.synthesize(ctx)` (DESIGN.md §21;
`SynthesisContext` in `src/core/types.ts`). The synthesizer is a *search inside one propose stage*.

### 4.1 What one step is

One `synthesize(ctx)` call = one **site-set search** under a per-step budget (≤ 60 Jev requests, ≤ 24 test
runs, ≤ 90 s Jev+test wall on QuixBugs-size suites, ≤ `ctx.limits.commandTimeoutMs × 8` on pytest suites)
that ends with exactly one Proposal. The engine's execute stage applies it; judge/complete run as usual; the
plan and window carry the search's summary into the next step.

### 4.2 Proposal kinds returned

| Situation at the end of the search | `action` | `goal` | `plan` |
| --- | --- | --- | --- |
| a candidate passed selections (1)+(2)+(3) and Q-GENUINE ≥ 0.7 | `patch` (unified diff, all touched files, `extraEdits` included) | "fix `<test ids>` at `<file>:<line>`: `<change>`" | `done` += the fixed test ids; `remaining` = still-failing test ids (usually empty) |
| a candidate improved without regression (second base) and the budget ran out | `patch` of the best base | "partial: `<k>` more tests pass" | `remaining` = still-failing ids; `openProblems` = "`<n>` candidates tested at `<sites>`; best `<p>`" |
| nothing improved | `run` of the reproduction command (the failing tests, `-q`) | "reproduce `<test ids>`; widened to `<n>` sites, `<m>` candidates" | `openProblems` = the search trace summary (sites, sources exhausted, fix-absent flags) |
| every selected test passes at the base and the full suite passes | `done` with the summary | — | `remaining` = [] |
| the base's full suite passes but a previously fixed test now fails after another step (regression found by the judge) | `patch` reverting to the recorded best base | — | `harnessProblems` already carries the judge's note |

`read` is never returned (context files come from the context stage; the localiser reads what it needs through
`ctx.workspace.read`). `rawText` carries the `SearchTrace` JSON (§7) for the transcript.

### 4.3 Plan and progress tracking

- `plan.remaining` is the list of failing test ids at the last base run, one item each (≤ 20, then "and N
  more"); `plan.done` gets an item per test fixed with `evidence.step`. The judge's `done_<j>` Nouls then see
  the applied patch and the test output, which is the evidence they are designed for (DESIGN.md §6 Plan rule a).
- Progress across steps is the code-computed pass count of the base; the `WindowEntry.notes` for a synth step
  hold `sites tried`, `sources exhausted`, `fixProbablyAbsent` flags and the best candidate's P, so the next
  step's localiser can down-weight exhausted sites (they are placed in the state as `already_tried_sites`
  and excluded from Q-LINE's options unless nothing else remains).
- The second base survives across steps as a recorded diff in the search state (checkpointed with the run);
  the engine's workspace holds only the accepted base.

### 4.4 Loop and stuck detection

Inside a step: a round that tests three candidates and changes neither the pass count nor the failing set
advances to the next round; two consecutive rounds whose candidate sets have the same signature (sha of sorted
line texts) end the site; `fixProbablyAbsent` on both the seed ranking and the concrete re-ranking of the sketch
fills skips straight to the token beam. Across steps: the engine's loop detector already fires on
`patch:<sha>` and `run:<sha>:<result>` signatures repeated three times (DESIGN.md §6); a synth step that returns
the same `run` reproduction twice makes the third trip a replan, and the directive `change_approach` /
`gather_context` arrives as `ctx.directive`, which the synthesizer consumes as: `change_approach` → drop the
top-3 sites and their tested candidates, widen to all lines of the top-5 functions by combined Jev + Ochiai
score (`src/synth/sbfl/`; lit-search-based-repair §6: Ochiai top-5 34/38 when passing tests exist);
`gather_context` → re-run Q-FILE/Q-CONFIRM with the traceback frames of the failing run in the state
(`localize/outline.ts` `tracebackFrames`); `revert_changes` → propose the revert patch of the current base;
`stop_and_report` → return `run` with the trace and let the engine stop. `max_replans` and `max_steps` bound
the whole thing; a step never exceeds its own budget, so the run's spend cap is reached only by design.

### 4.5 What "done" means

Done is a code fact, then a Jev consistency check: the base passes every test in selections (1)–(3) (for
QuixBugs, all upstream cases the reference passes within the alarm; for a repo, the failing tests and the module,
then the suite the engine's `testCommand` runs) **and** Q-GENUINE ≥ 0.7 for the accepted candidate (or ≥ 2
independent passing clusters agree). The synthesizer then proposes `done`; the engine's risk stage scores it,
execute records `noop`, and `task_complete` is asked with `workspace.lastTestRun.allPassed` and `testsCurrent`
true, so the existing completion rule fires (DESIGN.md §5.5). A `done` proposed without a fresh full-suite run
is never produced.

## 5. Cost and latency budget per step (from the measurements)

Constants: Jev p50 190–250 ms per request at 1–5k input tokens, 256–330 ms at 10–16k (probe-swebench, this
pilot's Noul run: 12.7k tokens, 308 ms); $0.042 per million input tokens; QuixBugs-size state ≈ 1–5k tokens,
SWE-bench function-level state ≈ 3–15k (probe-swebench: max 16.2k, cap 32k never approached).

| Stage | Requests | Jev time (sequential critical path) | Cost, QuixBugs-size state | Cost, SWE-size state | Test runs |
| --- | --- | --- | --- | --- | --- |
| Baseline test run + failure views (code) | 0 | — | — | — | 1 |
| Localise: Q-FILE (≤ 4 concurrent) + Q-CONFIRM + Q-FN (5 concurrent) + Q-LINE (+ Q-LINE-NOUL) per function | 1 (single file) … 8–12 (repo) | 0.25 s … ~1.2 s | $0.00005 | $0.0025 (probe-swebench §8) | 0 |
| Round 0: mutate/templates/donor seeds → Q-RANK (Nouls ≤ 254 in ≤ 3 concurrent chunks + Choice) | 2 | 0.6 s | $0.0008 (compact, 254) | $0.003–0.004 (18k → 60k tokens; chunk to stay under 32k) | 3 |
| Round 1: Q-SKETCH + Q-EDIT-CLASS | 1 | 0.25 s | $0.00019 (measured, 4.6k tokens) | ~$0.0008 | 0 |
| Round 2: Q-SLOT depths × (K sketches × B) | 1.7 (S2-like) … 5.4 (S1-like) per depth set, ≤ 12 | 0.4–1.3 s | $0.0002–0.0007 (measured $0.00012/request) | $0.001–0.004 | 0 |
| Round 2 concrete re-rank Q-RANK + tests | 1–2 | 0.3 s | $0.0002 | $0.001 | 3 |
| Round 3: token beam W = 3 + grammar (fallback only) | ~31 | 3.3 s | $0.0037 (measured) | ~$0.015 | 3 |
| Round 4 / second site: repeat Rounds 0–2 | 5–9 | 1.5 s | $0.0015 | $0.006 | 6 |
| Accept: full suite + Q-GENUINE (+ Q-CLUSTER) | 1 | 0.25 s | $0.0001 | $0.0005 | 1–2 |
| **Typical step (QuixBugs)**: localise + Round 0 succeeds | **5–6** | **~1.5 s** | **~$0.001** | — | **4–5** |
| **Reach step (QuixBugs)**: Rounds 0–2 at one site | **10–14** | **~3 s** | **~$0.003** | — | **7–10** |
| **Worst step (QuixBugs)**: two sites + token beam | **≤ 60** | **≤ 10 s** | **≤ $0.012** | — | **≤ 24** |
| **Typical step (SWE-bench)**: repo localise + Rounds 0–2 at 2 sites | **20–30** | **6–9 s** | — | **$0.02–0.04** | **8–12 pytest runs, 10–60 s each → 2–10 min** |

Wall time is test-bound, not Jev-bound (prototype: 240 ms Jev p50, 1.0 s median program). A QuixBugs
program is expected at 5–15 s and $0.002–0.005 (vs the ≥ $0.05 / 2 min criterion in JEV-ONLY.md); a
SWE-bench step at 2–10 min and $0.03, so a 10-step run is ≈ $0.3 of Jev and 20–60 min of pytest.

## 6. Predictions and the measurement each rests on

### 6.1 QuixBugs Python (40 programs), end to end, tests as oracle, one run

| Component | Rate used | Measurement |
| --- | --- | --- |
| Site found in the localisation beam (top-3 of Q-LINE ∪ Q-LINE-NOUL, plus insert gaps around the top lines) | 38/40 lines; the 2 misses (`lis` p 0.02, `mergesort` p 0.03) are reached by the Round-4 widening to all lines (1 request per line set, selection given the line is right: `mergesort` 0.54–0.93, `lis` 0.4–0.5 in probe-question-design §4) | probe-localization.md §1, §5; probe-question-design.md §5 |
| Replace bugs solved by Round 0 at the true site | 34/36 (prototype 32/40 = 29 first shot + 3 round-2, minus 2 localisation misses and 2 greedy traps that this design removes, plus the beam-of-bases keeping the round-1 queue) | prototype-baseline.md totals, failure taxonomy |
| Insertions solved by Round 1–2 | 4/4 sketch top-1 at P 0.75–0.92 (Appendix A) × changed-identifier fill 13/13 (probe-donor 2a) × placement 4/4 given the statement (probe-donor 4a); the prototype had 0/4 genuine | Appendix A; probe-donor-and-templates.md |
| Replace bugs Round 0 misses that Rounds 1–2 recover | `sqrt` fails in every measured route (probe-tokens, lit-synthesis S1/S2, prototype ranking); `shortest_paths` needs depth 2 | probe-token-synthesis.md §6; lit-guided-synthesis.md §5.3 |
| Run-to-run noise | ±2 programs (prototype: 30 repaired in both runs, 34 in either; Appendix A: 31/40 identical ranks across runs) | prototype-baseline.md; Appendix A |
| Overfitting | 1/32 repairs overfit with tests as the only oracle (`depth_first_search`) | prototype-baseline.md |

**Prediction: 35 ± 2 repaired (87 %), of which ≥ 33 correct by inspection; structural ceiling 38–39/40
(`sqrt`, `shortest_paths`).** Cost ≈ $0.10 for all 40 (prototype $0.035 + sketch/slot rounds on the ~10
programs that need them + the 2 exhaustive widenings), wall ≈ 3–5 min at 3 programs in flight. Against the
literature table in lit-search-based-repair.md §5 this sits above AlphaRepair (27) and ChatGPT-with-hints (31)
and below ChatRepair (40), with no generating model.

### 6.2 Ladder step 2–3 (two coordinated one-line fixes; missing guard + new line)

Two-hunk tasks are two steps of §4: the first step accepts a partial base if the first hunk alone makes a test
pass, otherwise the second-base mechanism carries the best partial into step 2 with `remaining` naming the
still-failing tests. Expected: solved when each hunk is individually testable (prototype: 3/3 genuine two-step
repairs `find_first_in_sorted`, `minimum_spanning_tree`, `sieve` succeeded once the first edit improved the pass
count); not solved when neither hunk changes the pass count alone (no measurement; risk 2).

### 6.3 SWE-bench Verified slice (30 instances)

| Component | Rate used | Measurement |
| --- | --- | --- |
| Gold patch fully reachable by the sources of §2 | 9/30 (2-sub donors), 6/30 strict; vocabulary ceiling 15/30 | coverage-study.md headline |
| Localisation chain (gold file #1, touched fn top-5, line ±3 top-5) from the issue text alone | 21/30 | probe-swebench-understanding.md chained view |
| Reachable ∧ located | the nine reachable instances are mostly small, well-located fixes (`django-15572`, `requests-2931`, `pylint-4970`, `pytest-7205`, `pytest-10051`, `requests-1142`, `django-15315`, `django-15916`, `pylint-6386`); 7 of them are in the chained-21 (`django-15916`, `django-15315`, `pytest-7205`, `pytest-10051`, `pylint-4970`, `requests-1142`, `requests-2931`; `pylint-6386` file #17, `django-15572` fn rank 2 but in) | probe-swebench-understanding.md chained table |
| Ranking + verification at SWE line lengths (median 1,641 depth-1 mutants, pools near the cap, Jev order-sensitive on near misses ±0.3) | ≈ 0.5 (unmeasured at this scale; lit-search-based-repair §7 Noul top-1 26/34 at mean 295 candidates, but reshuffle moved `kth` 0.48 → 0.14) | lit-search-based-repair.md §7, verification |
| Multi-hunk instances (19/30) | only those whose hunks are individually test-visible; secondary files rank #5–#44 | coverage-study.md; probe-swebench-understanding.md failure taxonomy |

**Prediction: 2–4 / 30 instances with FAIL_TO_PASS passing and no PASS_TO_PASS regression (most likely
`pylint-4970`, `requests-2931`, `pytest-7205`, `pytest-10051`, `django-15572`), 0 of the 15 vocabulary-fail
instances by construction, at ≈ $0.3 and 20–60 min per instance.** Anything above 5/30 would need a generative
source for new names and new logic (coverage-study.md §5).

## 7. Module list for implementation (`src/synth/`)

Existing and reused as is: `py/` (tokenizer, structure, edits, similarity), `sbfl/` (Ochiai tracer),
`mutate/` (operators, seeds), `templates/` (8 families incl. two-line guards via `extraEdits`), `donor/`
(shape index, adaptation, hole questions), `beam/` (grammar filter, vocab, token beam, template→slot route,
permutations), `localize/` (file/confirm/function/line stages, sites, budget), `rank/` (Choice / hybrid /
two-stage Noul ranker with `fixProbablyAbsent`), `verify/` (apply, pytest and QuixBugs parsers, progress and
routing in code), `types.ts`.

New:

| Module | Responsibility | Measured basis |
| --- | --- | --- |
| `sketch/productions.ts` | P1–P13 over `Tok[]`; grammar preconditions (value/operand-start/depth/header); descriptions | Appendix A pool: 39/40, median 64 |
| `sketch/instantiate.ts` | `instantiates(sketch, line)`, hole classes, `holes()`; used by tests and by the fill stage to accept a fill | Appendix A coverage definition |
| `sketch/pool.ts` | ordering, dedupe, 254 cap, depth-2 composition on demand, exclusion of the unchanged line's shape | §1.4 |
| `sketch/questions.ts` | Q-SKETCH, Q-EDIT-CLASS state and wording (verbatim from Appendix A), K rule | Appendix A |
| `fill/state.ts`, `fill/beam.ts`, `fill/questions.ts` | slot beam over holed hypotheses: prefix-mode Q-SLOT for K × B items per request, p ≥ 0.9 single expansion, compile gate, same-class permutation in code; returns complete lines with Σ log p (generalises `beam/templates.ts` slot filling to any sketch) | lit-guided-synthesis §5 (S2 92 %), probe-tokens T2 |
| `search/hypothesis.ts` | the `Hypothesis` type, provenance, dedupe keys, tested-set per base | §1.1 |
| `search/controller.ts` | Rounds 0–4 per site, K/B rules, `fixProbablyAbsent` routing, second base, budgets, trace | §1.2, prototype lessons |
| `search/bases.ts` | ≤ 2 program bases with their `TestRunSummary`, diffs, revert | prototype §"Progress rounds" |
| `search/budget.ts` | per-step caps: requests, test runs, wall; concurrency limits | §3, §5 |
| `verify/select.ts` | failing-first / module / full-suite selections for QuixBugs and pytest; `-p no:cacheprovider`, `PYTHONDONTWRITEBYTECODE=1` | §3 |
| `verify/parallel.ts` | scratch copies per candidate, bounded concurrency through `ctx.sandbox`, timeout = min(limit, 3× baseline + 10 s) | §3 |
| `verify/genuine.ts` | Q-GENUINE, generated-input behavioural clustering, Q-CLUSTER | §3 acceptance (unmeasured; risk 3) |
| `plan/proposal.ts` | `SearchTrace` → `Proposal` (patch / run / done), plan items from test ids, notes for the window | §4.2–4.3 |
| `plan/directive.ts` | consumes `ctx.directive` (change_approach / gather_context / revert_changes / stop_and_report) into search-state changes | §4.4 |
| `index.ts` (`createSynthesizer`) | wires localizer, sources, ranker, sketch, fill, verifier, controller; emits `synth` events per round | DESIGN.md §21 |
| `test/fixtures/synth/sketch/` | the 40 QuixBugs buggy/fix pairs with their instantiating sketches (offline gold), recorded Jev answers from Appendix A for replay | Appendix A JSON |

## 8. The three biggest risks and the experiment that retires each

1. **Sketch anchoring: Jev cannot see the missing token behind a hole.** Appendix A: 6/40 programs rank ≥ 6
   in every run (`lcs_length` 34–35, `next_palindrome` 22–23, `sqrt` 18–20, `topological_ordering` 10–12,
   `mergesort` 8–10, `shortest_paths` uncovered); 13/40 have P(top) < 0.5 and only 4 of those have the shape in
   the top-3. The design routes low confidence to the concrete route, which handles 3 of the 5 (prototype
   repaired `lcs_length`, `next_palindrome`, `topological_ordering`), but the reach layer itself is blind exactly
   where reach is needed on real code (a `- 1` or `.is_zero` deep in a 20-token line).
   *Experiment (≈ $0.05, n = 40 + the 78 SWE modified lines):* re-ask Q-SKETCH with (a) **executed values** in
   the state, the buggy sub-expressions of the line evaluated on the failing input next to `expected` (the REPL
   idea, lit-guided-synthesis row 12), and (b) each sketch's description carrying **two concrete
   instantiations** from the slot vocabulary (`mid + 1`, `mid - 1` for `mid <op> _`). Retire if top-3 ≥ 35/40
   on QuixBugs and ≥ 60 % on the SWE modified lines, or if the union "sketch top-3 ∪ concrete Noul top-3"
   covers ≥ 38/40 at the true site (then the routing, not the sketch, carries the load). Script: extend
   `experiments/grammar-synthesis/sketch-probe.mts` with `--values` and `--examples` modes.

2. **Reach on real repositories is bounded by hunks, not by the line synthesiser.** coverage-study.md: 19/30
   gold patches have ≥ 2 code hunks and a fix is reachable only if every hunk is (6–9/30); secondary files rank
   #5–#44 (probe-swebench failure taxonomy); a hunk that does not change the pass count alone is invisible to
   the test oracle, and the second-base mechanism has never been run on a two-hunk task.
   *Experiment (≈ $0.30 Jev, ~2 h pytest):* the ladder step 2 set (10 hand-made two-hunk tasks from QuixBugs
   pairs and `examples/demo-py`, each hunk's test visibility labelled) plus the 9 reachable SWE instances with
   two conditions, gold file given vs own localisation, measuring per-hunk reach, FAIL_TO_PASS pass rate and
   how often the second base was needed. Retire if ≥ 7/10 ladder tasks and ≥ 4/9 SWE instances pass with own
   localisation; otherwise the outer loop needs a per-hunk decomposition question ("which failing test does
   this partial fix address") and a "relocalise with the diff in the state" stage, which the experiment also
   measures (Q-FILE re-asked after the first hunk).

3. **Plausible-but-wrong acceptance.** Tests alone accepted 1/32 overfit repairs on QuixBugs
   (prototype-baseline `depth_first_search`), lit-synthesis found an over-fitted `<= 0` at B = 5, and 53 % of
   plausible QuixBugs-Java patches overfit in the literature (lit-search-based-repair §4); the sketch beam
   *increases* the number of test-passing lines per program (Appendix A produces up to 3 kept shapes × 3 fills),
   so more plausible-but-wrong lines will pass 3–14 tests. Q-GENUINE and behavioural clustering are unmeasured.
   *Experiment (≈ $0.03):* on all 40 programs, use the first 3 tests as the only oracle, collect every
   candidate the engine finds that passes them (expected 60–120 lines), label each against the full upstream
   suite (overfit vs correct), and measure Q-GENUINE's AUROC and the cluster rule's precision at the accept
   threshold 0.7; also test the anti-pattern Nouls ("does the change delete behaviour the tests exercise", Tan
   et al.). Retire if AUROC ≥ 0.9 and the accepted set's overfit rate ≤ 5 %; otherwise the accept step must
   require held-out generated inputs to agree with the majority cluster before proposing `done`.

Second-tier risks, recorded: test runs are the binding budget (prototype), so pytest at 10–60 s per run makes
24 runs a 4–24 min step; Jev order-sensitivity on near misses (±0.3 on reshuffle, lit-search-based-repair
verification) argues for a shuffled re-ask when the top-2 margin is < 0.1 (probe-selection §6); the argmax
validator tie (`validate.ts` `ARGMAX_TOLERANCE`) drops ~1/2,000 flat Choices and should be a warning for a
ranker that reads `probabilities` anyway (probe-localization §7, probe-question-design §8).

---

## Appendix A. Pilot: the sketch Choice (D3) on QuixBugs, 2026-09-20

Scripts: `experiments/grammar-synthesis/sketch-probe.mts` (pool, gold matching, live runs; reuses the tokenizer,
corpus and runner of `experiments/probe-tokens/common.mts`), `experiments/grammar-synthesis/make_tables.py`
(tables below). Raw output: `experiments/grammar-synthesis/out/sketch-{offline,live,live-nouls}-run*.json`.
Model `typesafe/jev-1.13-20260917` via OpenRouter, pinned. Corpus: the 40 QuixBugs Python programs of
`experiments/probe-tokens/out/corpus.json` (36 replacements, 4 insertions), 3 tests in the state, the fix
position **given** (this measures the shape Choice, not localisation).

Reproduce:

```
cd /Users/prateekjannu/Documents/vscode/JevCode
node_modules/.bin/tsx experiments/grammar-synthesis/sketch-probe.mts offline                 # pool coverage, $0
env -u ANTHROPIC_API_KEY node --env-file=.env node_modules/.bin/tsx experiments/grammar-synthesis/sketch-probe.mts live run1        # $0.0077
env -u ANTHROPIC_API_KEY node --env-file=.env node_modules/.bin/tsx experiments/grammar-synthesis/sketch-probe.mts live run2        # $0.0077
env -u ANTHROPIC_API_KEY node --env-file=.env node_modules/.bin/tsx experiments/grammar-synthesis/sketch-probe.mts live-nouls run1  # $0.0213
python3 experiments/grammar-synthesis/make_tables.py
```

### A.1 State shape and questions (verbatim)

```json
{ "task": "The Python function `gcd` has a one-line bug. In `program` the faulty position is marked `<<<FIX THIS LINE>>>` (the marker keeps the correct indentation). The original wrong line at that position is `buggy_line`; the correct line is usually a small edit of it. The corrected program must make every entry of `tests` pass.",
  "program": "\ndef gcd(a, b):\n    if b == 0:\n        return a\n    else:\n        <<<FIX THIS LINE>>>",
  "buggy_line": "return gcd(a % b, b)",            // null for the 4 insertions; the task text then says "No line existed there: a new line must be inserted."
  "tests": [ { "input": [17, 0], "expected": 17 }, { "input": [13, 13], "expected": 13 }, { "input": [37, 600], "expected": 1 } ] }
```

`sketch` (Choice; options `sketch_aa` … with description `{ "shape": "return gcd(b, a % b)", "change": "swap two adjacent arguments or elements" }`, plus the builder's `none_of_these`):

> Each option is a sketch of the corrected line for the `<<<FIX THIS LINE>>>` marker in `program`. In a sketch, `_` stands for one identifier, number, string or True/False/None still to be chosen, `<op>` stands for one operator still to be chosen, and every other token is shown literally. Which sketch is the shape of the correct replacement line, so that with the right tokens in its holes every entry of `tests` passes? Read the sketches literally and compare them with `buggy_line`. Choose `none_of_these` if no listed sketch fits the correct line.

`edit_class` (Choice, same request; options with definition + two examples each: `substitute_one_token`, `insert_fragment`, `delete_fragment`, `reorder_tokens`, `reshape_line`, `insert_new_line`, + `none_of_these`):

> Which kind of edit turns `buggy_line` into the correct line for the `<<<FIX THIS LINE>>>` marker in `program`, so that every entry of `tests` passes? Judge the edit that would be written. Answer carefully and literally.

Run 3 adds `state.sketches` (the same option map) and `state.sketch_criteria: { yes_when, no_when }`, and one `contextNoul` per sketch: "Is `sketches.sketch_aa` the shape of the correct replacement line for the `<<<FIX THIS LINE>>>` marker in `program`, so that with the right tokens in its holes every entry of `tests` passes? Apply `sketch_criteria`. Judge this sketch on its own; other sketches are judged separately."

Gold: a pool sketch **instantiated by the fix line** (same length; literal tokens equal; `_` over a
name/literal; `<op>` over an operator). Rank = best rank over all instantiating sketches (1–2 per program).
Edit class truth is computed in code from the LCS token diff.

### A.2 Totals (n = 40)

| run | n | coverage | pool median / max | top-1 | top-3 | top-5 | MRR | escape argmax | Noul rank top-1 / -3 / -5 | edit-class top-1 | edit-class top-2 | cost | Jev p50 | input tokens / request |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| live-run1 | 40 | 39/40 | 64 / 138 | 23/40 | 29/40 | 33/40 | 0.66 | 3 | - | 28/40 | 36/40 | $0.0077 | 238 ms | 4,587 |
| live-run2 | 40 | 39/40 | 64 / 138 | 23/40 | 29/40 | 32/40 | 0.67 | 3 | - | 29/40 | 35/40 | $0.0077 | 243 ms | 4,587 |
| live-nouls-run1 (Choice + Nouls) | 40 | 39/40 | 64 / 138 | 26/40 | 31/40 | 33/40 | 0.72 | 8 | 21 / 29 / 32 | 24/40 | 36/40 | $0.0213 | 308 ms | 12,696 |

Total pilot spend $0.0367 (120 requests, from `usage.costUsd`; identical cost in runs 1 and 2 because cost is a
function of the identical input tokens). Stability: 31/40 programs have the same rank in runs 1 and 2; 28/40 are
top-3 in all three runs, 33/40 in at least one; rank ≥ 6 in every run: `lcs_length`, `mergesort`,
`next_palindrome`, `sqrt`, `topological_ordering` (+ `shortest_paths`, uncovered). Calibration (run 1):
P(top) ≥ 0.5 on 27 programs → top-1 right 21, top-3 25; P(top) < 0.5 on 13 → top-3 only 4. By edit class
(run 1, top-1 / top-3): substitute 6/10 / 7/10, insert_fragment 6/15 / 10/15, delete 2/2 / 2/2, reorder 4/5 /
5/5, reshape 1/4 / 1/4, insert_new_line 4/4 / 4/4. Per-sketch Nouls did **not** improve on the Choice here
(21 vs 26 top-1 in the same request), unlike for concrete candidates in probe-selection.md: a hole hides the
token that makes a candidate look right.

### A.3 Per-item rows (n = 40)

| program | kind | edit class (code) | pool | covered (matching sketches) | best instantiating sketch | Choice rank r1 / r2 / r3 | P(sketch) r1 | P(top) r1 | P(escape) r1 | Noul rank r3 (max Noul) | edit-class top-1 r1 / r2 / r3 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| bitcount | replace | substitute_one_token | 48 | Y (1) | `n <op> n - 1` | 1 / 1 / 1 | 0.58 | 0.58 | 0.21 | 1 (0.32) | Y / Y / Y |
| breadth_first_search | replace | substitute_one_token | 14 | Y (1) | `while _:` | 1 / 1 / 1 | 0.77 | 0.77 | 0.15 | 2 (0.51) | n / n / n |
| bucketsort | replace | substitute_one_token | 81 | Y (1) | `for i, count in enumerate(_):` | 1 / 1 / 1 | 0.90 | 0.90 | 0.06 | 1 (0.74) | Y / Y / Y |
| depth_first_search | insert | insert_new_line | 19 | Y (1) | `_._(_)` | 1 / 1 / 1 | 0.91 | 0.91 | 0.04 | 1 (0.78) | Y / Y / Y |
| detect_cycle | replace | insert_fragment | 44 | Y (1) | `if _ is None or hare.successor is None:` | 3 / 3 / 3 | 0.04 | 0.71 | 0.08 | 4 (0.41) | Y / Y / n |
| find_first_in_sorted | replace | substitute_one_token | 41 | Y (2) | `while lo <op> hi:` | 1 / 1 / 1 | 0.85 | 0.85 | 0.10 | 1 (0.69) | Y / Y / Y |
| find_in_sorted | replace | insert_fragment | 64 | Y (1) | `return binsearch(mid <op> _, end)` | 1 / 1 / 1 | 0.76 | 0.76 | 0.05 | 1 (0.69) | Y / Y / Y |
| flatten | replace | delete_fragment | 42 | Y (2) | `yield x` | 1 / 1 / 1 | 0.89 | 0.89 | 0.01 | 1 (0.92) | Y / Y / Y |
| gcd | replace | reorder_tokens | 80 | Y (1) | `return gcd(b, a % b)` | 1 / 1 / 1 | 0.86 | 0.86 | 0.09 | 1 (0.72) | Y / Y / Y |
| get_factors | replace | insert_fragment | 25 | Y (1) | `return [_]` | 1 / 1 / 1 | 0.85 | 0.85 | 0.01 | 1 (0.64) | Y / Y / n |
| hanoi | replace | substitute_one_token | 63 | Y (1) | `steps.append((start, _))` | 1 / 1 / 1 | 0.93 | 0.93 | 0.03 | 1 (0.61) | Y / Y / Y |
| is_valid_parenthesization | replace | reshape_line | 21 | Y (1) | `return _ <op> _` | 5 / 5 / 5 | 0.05 | 0.28 | 0.02 | 3 (0.78) | n / n / n |
| kheapsort | replace | insert_fragment | 36 | Y (1) | `for x in arr[_:]:` | 1 / 1 / 1 | 0.89 | 0.89 | 0.01 | 1 (0.80) | Y / Y / Y |
| knapsack | replace | substitute_one_token | 41 | Y (2) | `if weight <op> j:` | 1 / 1 / 1 | 0.81 | 0.81 | 0.04 | 1 (0.70) | Y / Y / Y |
| kth | replace | insert_fragment | 64 | Y (1) | `return kth(above, k <op> _)` | 1 / 1 / 1 | 0.52 | 0.52 | 0.08 | 1 (0.66) | Y / Y / Y |
| lcs_length | replace | insert_fragment | 125 | Y (1) | `dp[i, j] = dp[i - 1, j <op> _] + 1` | 35 / 34 / 34 | 0.00 | 0.27 | 0.30 | 33 (0.33) | Y / Y / n |
| levenshtein | replace | delete_fragment | 119 | Y (1) | `return levenshtein(source[1:], target[1:])` | 1 / 1 / 1 | 0.88 | 0.88 | 0.01 | 1 (0.73) | Y / Y / Y |
| lis | replace | insert_fragment | 48 | Y (1) | `longest = _(_, length + 1)` | 4 / 4 / 3 | 0.08 | 0.48 | 0.09 | 2 (0.48) | Y / Y / Y |
| longest_common_subsequence | replace | insert_fragment | 127 | Y (1) | `return a[0] + longest_common_subsequence(a[1:], b[_:])` | 3 / 7 / 6 | 0.05 | 0.46 | 0.12 | 27 (0.49) | Y / Y / n |
| max_sublist_sum | replace | insert_fragment | 52 | Y (1) | `max_ending_here = _(_, max_ending_here + x)` | 1 / 1 / 1 | 0.43 | 0.43 | 0.05 | 1 (0.73) | Y / Y / Y |
| mergesort | replace | substitute_one_token | 63 | Y (1) | `if len(arr) <op> _:` | 9 / 8 / 10 | 0.01 | 0.43 | 0.18 | 5 (0.26) | n / n / Y |
| minimum_spanning_tree | replace | reshape_line | 80 | Y (1) | `group_by_node[node] = group_by_node[u]` | 1 / 1 / 1 | 0.51 | 0.51 | 0.13 | 5 (0.30) | n / n / n |
| next_palindrome | replace | insert_fragment | 138 | Y (1) | `return [1] + (len(digit_list) <op> _) * [0] + [1]` | 22 / 23 / 23 | 0.00 | 0.68 | 0.06 | 12 (0.61) | n / n / n |
| next_permutation | replace | reorder_tokens | 92 | Y (1) | `if perm[i] < perm[j]:` | 3 / 3 / 2 | 0.06 | 0.59 | 0.07 | 2 (0.64) | n / n / n |
| pascal | replace | insert_fragment | 71 | Y (1) | `for c in range(0, r <op> _):` | 1 / 1 / 1 | 0.34 | 0.34 | 0.29 | 2 (0.52) | Y / Y / Y |
| possible_change | replace | insert_fragment | 37 | Y (1) | `if total < 0 or not _:` | 5 / 5 / 3 | 0.06 | 0.45 | 0.04 | 2 (0.36) | Y / Y / Y |
| powerset | replace | insert_fragment | 84 | Y (1) | `return _ <op>[[first] + subset for subset in rest_subsets]` | 3 / 2 / 1 | 0.08 | 0.28 | 0.37 | 1 (0.41) | Y / Y / Y |
| quicksort | replace | substitute_one_token | 131 | Y (2) | `greater = quicksort([x for x in arr[1:] if x <op> pivot])` | 3 / 2 / 1 | 0.07 | 0.55 | 0.14 | 1 (0.32) | n / Y / n |
| reverse_linked_list | insert | insert_new_line | 12 | Y (1) | `_ = _` | 1 / 1 / 1 | 0.88 | 0.88 | 0.07 | 1 (0.89) | Y / Y / Y |
| rpn_eval | replace | reorder_tokens | 57 | Y (1) | `op(token, b, a)` | 1 / 1 / 1 | 0.55 | 0.55 | 0.10 | 2 (0.54) | Y / Y / n |
| shortest_path_length | replace | reshape_line | 93 | Y (1) | `_ + length_by_edge[node, nextnode]` | 5 / 3 / 4 | 0.02 | 0.44 | 0.43 | 6 (0.32) | n / n / n |
| shortest_path_lengths | replace | reorder_tokens | 92 | Y (1) | `length_by_path[i, k] + length_by_path[k, j]` | 1 / 1 / 1 | 0.95 | 0.95 | 0.02 | 1 (0.85) | n / n / n |
| shortest_paths | replace | reshape_line | 69 | n (0) | (none; two edits) | - / - / - | - | 0.51 | 0.27 | - (0.20) | n / Y / n |
| shunting_yard | insert | insert_new_line | 22 | Y (1) | `_._(_)` | 1 / 1 / 1 | 0.92 | 0.92 | 0.03 | 1 (0.81) | Y / Y / Y |
| sieve | replace | substitute_one_token | 95 | Y (1) | `if _(n % p > 0 for p in primes):` | 6 / 6 / 3 | 0.01 | 0.49 | 0.30 | 8 (0.68) | Y / Y / Y |
| sqrt | replace | insert_fragment | 83 | Y (1) | `while abs(x - approx <op> _) > epsilon:` | 19 / 20 / 18 | 0.00 | 0.41 | 0.33 | 24 (0.28) | n / n / n |
| subsequences | replace | insert_fragment | 25 | Y (1) | `return [[]]` | 2 / 2 / 1 | 0.26 | 0.60 | 0.03 | 2 (0.54) | Y / n / n |
| to_base | replace | reorder_tokens | 73 | Y (1) | `result = alphabet[i] + result` | 1 / 1 / 1 | 0.91 | 0.91 | 0.02 | 1 (0.80) | Y / Y / Y |
| topological_ordering | replace | substitute_one_token | 125 | Y (1) | `if set(ordered_nodes).issuperset(nextnode._) and nextnode not in ordered_nodes:` | 12 / 10 / 11 | 0.01 | 0.26 | 0.35 | 9 (0.24) | n / n / Y |
| wrap | insert | insert_new_line | 16 | Y (1) | `_._(_)` | 1 / 1 / 1 | 0.75 | 0.75 | 0.05 | 1 (0.67) | Y / Y / Y |

### A.4 What this pilot means for the design

1. **Reach is real.** One production table (P1–P11) gives a shape the gold instantiates on 39/40 programs
   with a median of 64 options, including all four insertions (top-1, P 0.75–0.92) and every additive fix
   (`or not _`, `_(_, …)`, `[_:]`, `<op> _`). Composed with the measured slot fill (92 % at B = 3), the sketch
   route alone would reconstruct ≈ 27/40 lines at the true site, the same range as probe-tokens' five-route
   portfolio (27–28/40) at one third of the requests.
2. **Precision is not.** Top-3 29–31/40; the misses are one-token-deep additive edits in long lines where the
   hole removes the evidence (`- 1`, `** 2`, `.incoming_nodes`, `<= 1`). The same programs are the concrete
   route's strengths or its known hard cases (probe-selection §8 lists `next_palindrome`, `topological_ordering`,
   `sqrt`, `lcs_length`). Hence Round 0 (concrete) before Round 1 (sketch), and the low-confidence rule
   (P(top) < 0.5 or P(escape) ≥ 0.3 → K = 5 and tests decide) which covers 13/40 programs here.
3. **The edit-class Choice is a usable soft prior, not a gate**: 28–29/40 top-1, 35–36/40 top-2, with the
   confusions inside {substitute, insert_fragment} exactly as probe-donor §3 found for fix kinds.
4. **Per-sketch Nouls are not worth 2.8× the tokens** for shapes (21 vs 26 top-1 in one request); keep the
   Choice for sketches and the Nouls for concrete lines.
5. **Cost is negligible**: $0.00019 per program for the whole shape stage, 238 ms; the state is 4.6k tokens.

Caveats: the fix position was given (localisation is measured elsewhere at 28/40 top-1, 36/40 top-3); the
production table was written with the QuixBugs fix taxonomy in view (lit-guided-synthesis §5.4, coverage-study
operators), so 39/40 is a ceiling statement in the same sense as coverage-study.md's 40/40; three runs of 40 put
the noise at ±2–3 programs; no slot filling or test run was performed in this pilot (the composition with the
measured S2 rate is arithmetic, not a measurement).
