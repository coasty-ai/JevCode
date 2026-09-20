# Search-based and template-based program repair without LLMs: what carries over to a Jev-ranked search

Topic: lit-repair. Written 2026-09-20. All URLs fetched 2026-09-20 (PDFs pulled with curl, text extracted
with pypdf; page-level quotes are from those extractions). Two small measurements were run alongside the
survey so that the "expected coverage" and "Jev as ranker" claims are numbers rather than guesses:

- `experiments/lit-repair/quixbugs_operator_coverage.py` (no model calls): depth-1 operator catalogue vs the
  40 QuixBugs Python developer fixes, plus Ochiai/Tarantula/DStar ranks from real test coverage.
  Output: `experiments/lit-repair/quixbugs-operator-coverage.json`.
- `experiments/lit-repair/jev-rank-probe.mts` (live Jev, $0.0545): Jev ranks the developer fix among all
  operator candidates for the buggy line (mean 295 candidates). Output: `experiments/lit-repair/jev-rank-results.json`.
  Verification re-runs (2026-09-20, `PROGRAMS=... OUT=...` env hooks added to the script): `jev-rank-verify-sample.json`,
  `jev-rank-verify-sameseed.json`. See "Verification (2026-09-20)" at the end.

## 1. The tools, what they enumerate, how they rank, what they fixed

| Tool (venue) | Candidate source | Ranking / search | Headline result | Source |
| --- | --- | --- | --- | --- |
| GenProg (ICSE 2009, TSE 2012, ICSE 2012) | statement-level copy / delete / swap of statements already in the program (redundancy assumption) | genetic programming, fitness = weighted test pass count | 16 C programs, "average success rate of 77 percent"; the 2012 systematic study: 55 of 105 bugs "for $8 each". Later re-analysis: only 1 of 69 defects correctly (most plausible patches delete functionality) | [TSE 2012](https://web.eecs.umich.edu/~weimerw/p/weimer-tse2012-genprog.pdf); correct-count from [Long & Rinard 2016](https://arxiv.org/pdf/1602.05643) |
| RSRepair (ICSE 2014) | same operators as GenProg | random search instead of GP; test-case prioritisation | "in most cases (23/24) outperforms GenProg" in patch trials and test executions; higher (16/24) or equal (7/24) success rate. Message: the GP fitness function was not doing the work | [Qi et al.](http://qiyuhua.github.io/publications/icse2014-qi.pdf) |
| SPR (FSE 2015) | six parameterised transformation schemas (below) with abstract conditions | staged: target-value search decides whether any condition could work before synthesising one; hand-coded prioritisation heuristics | search space contains correct repairs for 19 of 69 C defects; correct patch is first to validate for 11 of 19; plausible for 38 of 69 | [Long & Rinard](https://www.cs.toronto.edu/~fanl/papers/spr-fse15.pdf) |
| Prophet (POPL 2016) | SPR search space | learned log-linear ranker over 3,515 binary features (455 modification features, 3,060 program-value features) trained on 777 human patches | correct patch found for 18 of the 19 in-space defects; first-to-validate correct for 15 of 19 (SPR: 11; random order: 7; localisation-order baseline: 8). Mean normalised rank of the first correct patch: top 11.5 % of the space (random 41.8 %, SPR heuristics 17.5 %). Disabling program-value features: still 18 found, but first-to-validate drops 15 → 10 | [Long & Rinard](https://people.csail.mit.edu/fanl/papers/prophet-popl16.pdf) |
| Angelix (ICSE 2016) | semantics-based: symbolic execution extracts "angelic" values, then expression synthesis (MaxSMT) | constraint solving, prefers minimal syntactic change | 28 of 32 defects in its defect class repaired; 10 of 28 functionally equivalent to developer fixes; ~30 min per repair; multi-location repairs; Heartbleed | [Mechtaev et al.](https://mechtaev.com/files/icse16.pdf) |
| TBar (ISSTA 2019) | 15 fix-pattern categories / 35 concrete templates collected from the literature (Section 2) | fixed pattern order; ingredients from the local file; stop at first plausible patch | Defects4J: 74 correct / 101 plausible with perfect localisation; 43 / 81 with GZoltar + Ochiai. kPAR (PAR re-implementation) 36 / 55 with perfect localisation, 18 / 49 with normal FL. "Most bugs are correctly fixed only by a single fix pattern while other patterns generate plausible [incorrect] patches" | [Liu et al.](https://arxiv.org/pdf/1903.08409); kPAR normal-FL numbers from [Liu et al. 2019 "You cannot fix what you cannot find"](https://kui-liu.github.io/papers/liu2019you.pdf) |
| SimFix (ISSTA 2018) | intersection of an abstract space mined from existing patches and a concrete space obtained by AST differencing against similar code snippets in the same project | similarity (structural, variable-name, method-name) ranking of donor snippets; fine-grained AST-subtree reuse | 34 of 357 Defects4J bugs correct, 22 plausible-but-incorrect; 13 never fixed before | [Jiang et al.](https://xiongyingfei.github.io/papers/ISSTA18a.pdf) |
| CapGen (ICSE 2018) | 30 "augmented mutation operators" (AST node type + operation) mined from BugFixSet, covering 69.69 % of repair actions [figure not found in the pypdf text on re-fetch; unverified]; ingredients from the buggy file | context-aware prioritisation: genealogy context (ancestor / sibling node types), variable context, dependency context; operator frequency prior | 224 Defects4J bugs: 25 plausible, 21 correct (precision 84.00 %) [corrected 2026-09-20: the paper says 21; 22 was a transcription error]; correct patches ranked before 98.78 % (164/166) of incorrect plausible ones; incorrect plausible patches generated for 40 % (10/25) of bugs but ranked after the correct one in 21 of 22 | [Wen et al.](https://tjusail.github.io/people/chenjunjie/files/ICSE18.pdf) |
| ssFix (ASE 2017) | syntactic code search: the buggy statement plus context as a "target chunk", candidates are structurally similar chunks from the local program and an external codebase, names unified | TF-IDF-style syntactic similarity; first passing patch reported | 20 of 357 Defects4J bugs with valid patches | [Xin & Reiss](https://cs.brown.edu/people/qxin/papers/repair_ase17_preprint.pdf) |
| ARJA (TSE 2018) | GenProg-style statement ingredients with type matching | lower-granularity GP representation decoupling location / operation / ingredient; NSGA-II multi-objective (tests failed, patch size) | 224 Defects4J bugs: plausible 27 → 59, correct 5 → 18 vs jGenProg | [Yuan & Banzhaf](https://arxiv.org/pdf/1712.07804) |
| Refactory (ASE 2019) | reference solutions refactored into semantically equivalent variants; the closest control-flow match donates block-level specifications; search-based synthesis inside blocks | control-flow-graph matching, then per-block synthesis | 1,783 incorrect Python student submissions: repairs 90.8 %; works from a single reference solution; ~30 % smaller patches than Clara | [Hu et al.](https://mechtaev.com/files/ase19.pdf) |
| Astor (ISSTA 2016 demo; JSS 2019) | library with jGenProg, jKali, jMutRepair, DeepRepair, Cardumen, TIBRA; explicit extension points for operator selection and ingredient pools | probabilistic operator selection from commit-mined repair models; Cardumen mines expression templates from the program itself | 98 of 357 Defects4J bugs get a test-adequate patch across the six approaches (correctness not assessed) | [Martinez & Monperrus](https://arxiv.org/pdf/1802.03365) |

Meta-result (Long & Rinard, ICSE 2016, 1,104 search spaces, 768 runs): "correct patches are sparse in the
search spaces (typically at most one correct patch per search space per defect)", "incorrect patches that
nevertheless pass all of the test cases ... are typically orders of magnitude more abundant", and larger
search spaces "can actually cause systems to find fewer, not more, correct patches" because of validation
time and plausible-but-incorrect blockers. This is the core argument for a calibrated ranker in the loop.
[arXiv 1602.05643](https://arxiv.org/pdf/1602.05643).

### SPR's six transformation schemas (quoted)

"Condition Refinement: ... conjoining or disjoining an abstract condition to the original if condition";
"Condition Introduction: ... the statement executes only if an abstract condition is true"; "Conditional
Control Flow Introduction: ... a new control flow statement (return, break, or goto an existing label)
that executes only if an abstract condition is true"; "Insert Initialization"; "Value Replacement: ...
replace either 1) one variable with another, 2) an invoked function with another, or 3) a constant with
another constant"; "Copy and Replace: ... copy an existing statement to the program point before the
identified statement and then apply a Value Replacement transformation".

### TBar's fix-pattern catalogue (quoted, simplified GNU-diff form)

| Pattern | Template (as printed in the paper) |
| --- | --- |
| FP1 Insert Cast Checker | `+ if (exp instanceof T) { var = (T) exp; ...... + }` |
| FP2 Insert Null Pointer Checker | FP2.1 `+ if (exp != null) { ...exp...; ...... + }`; FP2.2 `+ if (exp == null) return DEFAULT_VALUE;`; FP2.3 `+ if (exp == null) exp = exp1;`; FP2.4 `+ if (exp == null) continue;`; FP2.5 `+ if (exp == null) throw new IllegalArgumentException(...);` with `DEFAULT_VALUE` = false / 0 / new String() / `return;` / null by return type |
| FP3 Insert Range Checker | `+ if (index < exp.length) { ...exp[index]...; ...... + }` or `+ if (index < exp.size()) { ...exp.get(index)... }` |
| FP4 Insert Missed Statement | FP4.1 `+ method(exp);`; FP4.2 `+ return DEFAULT_VALUE;`; FP4.3 `+ try { statement; ...... + } catch (Exception e) { ... }`; FP4.4 `+ if (conditional_exp) { statement; ...... + }` |
| FP5 Mutate Class Instance Creation | `- ... new T(); + ... (T) super.clone();` inside an overridden `clone()` |
| FP6 Mutate Conditional Expression | FP6.1 `- ...condExp1... + ...condExp2...`; FP6.2 `- ...condExp1 Op condExp2... + ...condExp1...`; FP6.3 `- ...condExp1... + ...condExp1 Op condExp2...` (Op is `||` or `&&`) |
| FP7 Mutate Data Type | FP7.1 `- T1 var ...; + T2 var ...;`; FP7.2 `- ...(T1) exp...; + ...(T2) exp...;` |
| FP8 Mutate Integer Division | `dividend / divisor` → `dividend / (double) divisor`, `(double) dividend / divisor`, `(1.0 / divisor) * dividend` |
| FP9 Mutate Literal Expression | FP9.1 `- ...literal1... + ...literal2...`; FP9.2 `- ...literal1... + ...exp...` |
| FP10 Mutate Method Invocation | FP10.1 `method1(args)` → `method2(args)` (compatible return type, same parameter types); FP10.2 replace an argument `method1(arg1, arg3, ...)`; FP10.3 remove an argument; FP10.4 insert an argument |
| FP11 Mutate Operators | FP11.1 `exp1 Op1 exp2` → `exp1 Op2 exp2` (same operator class); FP11.2 `(exp1 Op1 exp2) Op2 exp3` → `exp1 Op1 (exp2 Op2 exp3)`; FP11.3 `exp instanceof T` → `exp != null` |
| FP12 Mutate Return Statement | `- return exp1; + return exp2;` |
| FP13 Mutate Variable | FP13.1 `- ...var1... + ...var2...`; FP13.2 `- ...var1... + ...exp...` (compatible type) |
| FP14 Move Statement | `- statement; ...... + statement;` |
| FP15 Remove Buggy Statement | FP15.1 delete the statement; FP15.2 delete the enclosing method body |

Source: [TBar, arXiv 1903.08409](https://arxiv.org/pdf/1903.08409), Section 2.2. The paper also reports that
~79 % (314/395) of Defects4J bugs cannot be fixed by these patterns even with perfect localisation, blaming
(1) missing patterns and (2) "ineffective search of fix ingredients" limited to the local file.

## 2. Plastic-surgery hypothesis and fix-ingredient locality

| Finding | Number | Source |
| --- | --- | --- |
| Commits graftable from the parent version (line-granular, whitespace-normalised) | "on average, changes are 43% graftable, and that 11% of them can be 100% graftable" over 15,723 commits in 12 Java projects | [Barr et al. FSE 2014](https://people.cs.umass.edu/~brun/pubs/pubs/Barr14fse.pdf) |
| Extra grafts from older versions / other projects | non-parental ancestors add only 5 %, other projects 9 %; parent is the "most fecund source" (effect sizes 0.84, 0.80) | same |
| Same-file locality | "30% of the donor snippets can be found in the same donor file and 9% in the same package" | same, Section 4.5 |
| Contiguity | "graftable portions of a patch can usually be composed out of lines from just one contiguous donor graft site, and very often from no more than two" | same |
| Temporal redundancy of whole commits (all lines already present) | line level 3–17 % of commits; token level 31–52 %; restricting to the same file: 2–16 % (lines), 8–29 % (tokens) | [Martinez, Weimer, Monperrus ICSE-NIER 2014](https://arxiv.org/pdf/1403.6322) |
| Where Defects4J repair ingredients actually are | ~50 % (199/395) of bugs need donor code outside the buggy program; when available it is mostly "intrinsic" (operators, constructs; 44 bugs fixable with intrinsic donors alone) or in the buggy method/file; ~75 % of bugs need three or fewer change actions; 68.4 % of fixes target AST depth 4–7 | [Yang et al. EMSE 2021](https://www.darkrsw.net/papers/EMSE2021.pdf) |
| Shape of real patches (Defects4J, 395) | median patch 4 lines; ~30 % pure additions; 92.4 % touch one file; repair patterns: Conditional Block 42.8 %, Expression Fix 32.9 %, Wraps-with 27.3 %, Single Line 24.8 %, Wrong Reference 17.7 %, Missing Null-Check 12.7 %, Copy/Paste 12.2 %, Constant Change 4.8 %, Code Moving 1.8 % | [Sobreira et al. SANER 2018](https://arxiv.org/pdf/1801.06393) |
| Single-statement bugs in the wild (ManySStuBs4J, 153,652 single-statement fixes from 1,000 Java projects) | 16 SStuB patterns match 33.0–33.5 % of single-statement fixes: Change Identifier Used 12.8 %, Change Modifier 7.3 %, Wrong Function Name 5.8 %, Change Numeric Literal 4.5 %, Same Function More Args 3.0 %, Change Binary Operator 1.1 %, Less Specific If 0.8 %, Same Function Wrong Caller 0.7 %, Same Function Less Args 0.7 %, More Specific If 0.7 %, Change Unary Operator 0.7 %, Change Boolean Literal 0.7 %, Same Function Swap Args 0.5 %, Change Operand 0.5 %, Missing Throws 0.3 %, Delete Throws 0.2 % | [Karampatsis & Sutton MSR 2020](https://arxiv.org/pdf/1905.13334) |

Reading for the Jev design: the buggy file is the right first donor pool (30 % of grafts, and TBar/CapGen
both restrict to it), identifiers and operators ("intrinsic" ingredients) cover a large share of
single-line fixes, and the ~50 % of real bugs whose ingredients live outside the program are out of reach
for any code-proposes system regardless of ranker.

## 3. Spectrum-based fault localisation

Formulas (failed(s), passed(s): failing/passing tests covering s; totalfailed, totalpassed):

- Tarantula: `(failed(s)/totalfailed) / (failed(s)/totalfailed + passed(s)/totalpassed)`
- Ochiai: `failed(s) / sqrt(totalfailed * (failed(s) + passed(s)))`
- DStar (D* with * = 2): `failed(s)^2 / (passed(s) + (totalfailed - failed(s)))`
- Barinel: `1 - passed(s) / (passed(s) + failed(s))`

| Study | Subjects | Top-N result | Source |
| --- | --- | --- | --- |
| Pearson et al. ICSE 2017 | 395 real Defects4J faults (+ 3,242 artificial) | Best case (any faulty statement): DStar top-5 30 %, top-10 39 %, top-200 82 %; Metallaxis 29 / 39 / 77 %; their MCBFL hybrid 36 / 45 / 85 %. Real faults reversed 30 % of claims made on artificial faults; "Ochiai > Tarantula" and "DStar > Ochiai" are not significant on real faults; the formula explains ≤ 2 % of EXAM variance. 76 % of real fixes are multi-statement, 30 % are faults of omission (no statement to point at) | [PDF](https://homes.cs.washington.edu/~rjust/publ/fault_localization_effectiveness_icse_2017.pdf) |
| Widyasari et al. EMSE 2022 | 493 real Python faults, BugsInPy | Ochiai best case: top-5 14.19 %, top-10 19.87 %, top-200 50.30 % (Defects4J on the same implementation: 32.41 / 42.53 / 81.77 %). Tarantula, Barinel, Ochiai significantly beat DStar and OP on Python | [PDF](https://shaoweiwang2010.github.io/papers/EMSE2022_Evaluating_Spectrum_Based_Fault_LocalizationTechniques_in_Python_Real_World_Projects.pdf) |
| Rezaalipour & Furia, EMSE 2024, arXiv 2305.19834 (Python replication of Zou et al.) [author name corrected 2026-09-20; top-N percentages not re-verified] | 135 BugsInPy bugs, statement level, Einspect rank | SBFL (Ochiai = DStar = Tarantula within rounding): localised within top-1 12 %, top-3 30 %, top-5 43 %, top-10 54 %; SBFL is the best standalone family | [PDF](https://arxiv.org/pdf/2305.19834) |
| This work | 40 QuixBugs Python programs, JSON/pytest tests run under `sys.settrace` | Ochiai Einspect rank ≤ 1: 7/38, ≤ 3: 19/38, ≤ 5: 34/38, ≤ 10: 38/38 (mean 3.26); worst-case tie rank ≤ 1: 7/38, ≤ 5: 21/38. 7 programs have zero passing tests, so every executed line ties. DStar identical to Ochiai at top-1 (7) and top-5 (34); Tarantula 4 / 34 | Section 6 |

Compare the anchor probe: Jev's Choice over all lines put the buggy line top-1 on 13/14 programs
(`experiments/results/anchor-probe.md`), where Ochiai gets 7/38 top-1 with heavy ties. On tiny programs
with mostly-failing suites SBFL is a tie-breaker at best; Jev reads the test and the code and does not need
passing tests.

## 4. Overfitting and how test-based validation is combined with rankers

| Finding | Source |
| --- | --- |
| Smith et al. FSE 2015 ("Is the cure worse than the disease?"): with held-out white-box tests, the median GenProg patch passes 75.0 % of the evaluation suite (mean 68.7 %), TrpAutoRepair 75.0 % (mean 72.1 %), AE 50.0 % (mean 64.2 %); quality is proportional to training-suite coverage; "for programs that pass most tests, the tools are as likely to break tests as to fix them" | [PDF](https://people.cs.umass.edu/~brun/pubs/pubs/Smith15fse.pdf) |
| Long & Rinard 2016: plausible-but-incorrect patches are orders of magnitude more abundant than correct ones; stronger test suites shrink the plausible set but GenProg is left with "the five correct patches in its search space" | [arXiv 1602.05643](https://arxiv.org/pdf/1602.05643) |
| Ye et al. 2019/2021 (QuixBugs Java, 10 tools): 338 unique plausible patches for 16 programs; manual assessment 158 correct, 180 overfitting (53.3 %); only 7/40 programs correctly repaired. Automated assessment: regression tests generated by EvoSuite against the ground truth classify overfitting with 98.2 % accuracy, input sampling 80.8 %, ground-truth invariants 58.3 % | [arXiv 1805.03454](https://arxiv.org/pdf/1805.03454) |
| Tan et al. FSE 2016 anti-patterns: seven generic forbidden shapes (deleting control-flow exits / whole branches, adding trivial conditions or early exits, ...) integrated into GenProg and SPR; on 86 real bugs they improve localisation of the correct line or function, remove less functionality and speed up search | [PDF](https://abhikrc.com/pdf/FSE16.pdf) |
| CapGen: rank first, validate in rank order, stop at first plausible; the ranker's job is to put the correct patch ahead of the plausible-but-incorrect ones (98.78 % achieved) | [PDF](https://tjusail.github.io/people/chenjunjie/files/ICSE18.pdf) |
| Prophet: the same — the first patch to validate is correct for 15/19 defects because the learned ranker ordered it first | [PDF](https://people.csail.mit.edu/fanl/papers/prophet-popl16.pdf) |
| Astor JSS 2019 survey of filters: Opad filters 75.2 % (321/427) of overfitted GenProg/AE patches via fuzzing + memory-safety oracles; a static-analysis filter removed 56.3 % of incorrect patches "without blocking any correct patches" | [arXiv 1802.03365](https://arxiv.org/pdf/1802.03365) |

Pattern that generalises: **rank → validate in order → stop at first plausible**, with an independent
correctness signal (anti-patterns, held-out or generated tests, a learned or judged correctness score)
between "plausible" and "accepted". Tests alone accept ~50 % wrong patches on QuixBugs Java.

## 5. QuixBugs Python baseline table

| System (year) | Kind | QuixBugs Python correct / 40 | QuixBugs Java correct / 40 | Source |
| --- | --- | --- | --- | --- |
| 10 classic tools together (Arja, Cardumen, Dynamoth, jGenProg, jMutRepair, jKali, Nopol, NPEFix, Tibra, RSRepair) | search / synthesis, Java only | – | 7 correct (16 plausible); per tool: Cardumen 5, Nopol 4, jGenProg 4, Arja 4, RSRepair 3, jMutRepair 3, others ≤ 2 (plausible counts, before manual assessment) | [Ye et al.](https://arxiv.org/pdf/1805.03454) |
| Astor / Nopol / RSRepair as reported by CURE | search / synthesis, Java | – | 6 / 1 / 2 correct (11 / 4 / 4 plausible) | [CURE, Table I](https://arxiv.org/pdf/2103.00073) |
| CoCoNuT (ISSTA 2020) | NMT ensemble | 19 | 13 (20 plausible) | [Prenner & Robbes Table II](https://arxiv.org/pdf/2111.03922); [CURE](https://arxiv.org/pdf/2103.00073) |
| DeepDebug (2021) | fine-tuned transformer, Python | 21 | – | [Prenner & Robbes](https://arxiv.org/pdf/2111.03922) |
| CURE (ICSE 2021) | code-aware NMT, Java | – | 26 (35 plausible) | [CURE](https://arxiv.org/pdf/2103.00073) |
| Codex (2021, single sample) | LLM, zero-shot | 23 (code + docstring), 21 (code only), 19 (code + hint), 18 (docstring only) | 14 | [Prenner & Robbes](https://arxiv.org/pdf/2111.03922) |
| AlphaRepair (FSE 2022) | cloze-style masked LM | 27 | 28 | [Xia & Zhang](https://arxiv.org/html/2207.08281) |
| ChatGPT (Sobania et al. 2023) | LLM dialogue with hints | 31 | – | [arXiv 2301.08653](https://arxiv.org/abs/2301.08653) |
| ChatRepair (2023 / ISSTA 2024) | conversational LLM with test feedback | 40 | 40 | [arXiv 2304.00385](https://arxiv.org/pdf/2304.00385) |
| **Jev-only target** (`docs/JEV-ONLY.md`) | code proposes, Jev ranks, tests verify | ≥ 24 (60 %) end to end is the "surprisingly well" bar | – | – |

No template-based tool has published QuixBugs *Python* numbers; the classic-tool ceiling on QuixBugs Java is
7/40 correct (17.5 %) with 53 % of plausible patches overfitting. A Jev-ranked operator search that reaches
the mid-20s on Python would sit between Codex-zero-shot and ChatGPT-with-hints without any generating model.

## 6. Measurement A: operator coverage and SBFL on QuixBugs Python (no model)

Script `experiments/lit-repair/quixbugs_operator_coverage.py`. Buggy and correct programs both carry a
trailing `"""` block (docstring / alternative solutions) that is stripped; comment-only lines are ignored
in the diff. n = 40. 36 fixes are one-line replacements, 4 are one-line insertions, 0 are deletions.

Depth-1 operator catalogue (each applied once to one line; candidates deduplicated after whitespace
normalisation): relational swap, arithmetic swap, bitwise swap, augmented-assignment swap, `and`/`or` swap,
negation add/remove, off-by-one (`±1` on identifiers, calls, indexes; drop a leading `1 +`), literal ±1,
literal swap (`True/False/0/1/2/''/None/[]/[[]]`), literal → identifier or `Y == 0`/`Y != 0`/`not Y`/`[Y]`,
identifier substitution from the file's identifier set (+ builtins), attribute/method substitution, adjacent
argument swap inside `(...)` and `[...]`, operand swap around a binary operator, call unwrap `f(x)→x`, call
wrap `x→f(x)`, identifier extension `X→X[1:] | X[:-1] | X[k:] | X**2 | X*X | X op Y`, call → identifier,
`max(bound, rhs)`/`min(bound, rhs)` wrap, prepend term `Y + rhs`, condition extension `C or not Y | C or Y |
C and Y | C and not Y | Y is None or C | Y is not None and C`, None-guard on `X.attr` in conditions,
boundary rewrite `== 0 ↔ <= 1`, slice-bound edits, statement deletion. Insertion templates: `{x}.append({y})`,
`{x}.add({y})`, `{x} = {y}`, `return {x}`, `{x} += 1`, and a dozen similar.

| Measurement | Result |
| --- | --- |
| Developer fix reproduced exactly by one depth-1 operator / template | **38 / 40** (34 of 36 replacements, 4 of 4 insertions) |
| Uncovered | `minimum_spanning_tree` (`.update(Y)` → `= Y`, method call → assignment), `shortest_paths` (`weight_by_edge[u, v]` → `weight_by_node[v]`, two edits) |
| Candidates at the buggy line | median 278, max 935 |
| Candidates over the whole file (no localisation) | median 2,142, max 15,321 |
| Ochiai Einspect rank of the buggy line | ≤ 1: 7/38, ≤ 3: 19/38, ≤ 5: 34/38, ≤ 10: 38/38; mean 3.26; 2 buggy lines never traced: `breadth_first_search` L11 `while True:` (CPython emits no line event for a constant-true loop header) and `shunting_yard` L17–18, an insertion point inside an inner loop that the buggy program never enters (`opstack` is never filled), so the bug hides its own site from coverage |
| Programs with zero passing tests (all executed lines tie) | 7 / 40 |

**Caveat (in-sample):** the catalogue was extended twice after seeing which fixes were missed (the first cut
covered 14/40, the second 38/40). The 38/40 is therefore the coverage of a catalogue *fitted to* QuixBugs,
not an out-of-sample estimate. The operators themselves are the TBar / SStuB / SPR operators above, and
every one of them fires on ordinary Python, so the honest expectation for unseen one-line algorithmic
bugs is "most", and for real single-statement bugs in the wild roughly the SStuB match rate (one third)
plus what identifier substitution and off-by-one add.

## 7. Measurement B: Jev ranks the developer fix among all operator candidates (live)

Script `experiments/lit-repair/jev-rank-probe.mts`, model `typesafe/jev-1.13-20260917` via OpenRouter,
n = 34 (the covered one-line replacements; insertions have no candidate list yet). The true buggy line is
given (localisation is measured separately in the anchor probe); candidates are shuffled with a fixed seed.

State shape:

```json
{ "task": "The Python function `gcd` has a single-line bug on the line `buggy_line` (line L5). Exactly one entry of `candidates` is the developer's fix.",
  "program": { "L1": "def gcd(a, b):", "L2": "    if b == 0:", "...": "..." },
  "tests": [ { "input": [17, 0], "expected": 17 }, "... up to 4" ],
  "buggy_line": "return gcd(a % b, b)",
  "candidates": { "cand_001": "return gcd(a % b, a)", "cand_002": "...", "... 28..934 entries": "..." },
  "criteria": { "what_correct_means": "A candidate is the correct fix only if replacing `buggy_line` with exactly that text makes the function compute the expected output for every test (and for inputs like them), with no other change.",
                "not_correct": ["a change that makes only some tests pass", "a change that is syntactically plausible but leaves the algorithm wrong", "the original line unchanged", "a change to a part of the line that is not the defect"],
                "correct_examples": ["off-by-one fixed so a loop covers the last element the test expects", "swapped arguments restored to the order the algorithm requires"] } }
```

Stage 1, one Noul per candidate (`contextNoul`, criteria once in the state, batches of 300 per request):
"Is `candidates.cand_017` the correct replacement for `buggy_line` according to `criteria`, so that all
`tests` pass? Answer carefully and literally."

Stage 2, Choice over all candidates when ≤ 254, otherwise over the Noul top-100, with escape option:
"Which entry of `candidates` is the correct replacement for `buggy_line` according to `criteria`, so that
all `tests` pass? Pick `none_of_these` if no entry is a correct fix."

| Measurement | Result |
| --- | --- |
| Mean candidates per program | 295 (range 28–934) |
| Noul ranking: developer fix top-1 / top-5 / top-10 | **26 / 34**, 31 / 34, 31 / 34; MRR 0.831 |
| Choice over shortlist: top-1 / top-5 | 23 / 34, 32 / 34; MRR 0.780 |
| Noul top-100 shortlist ever cut the true fix | 0 / 20 programs with > 254 candidates (corrected 2026-09-20; was "12") |
| Choice argmax was the escape option `none_of_these` | 9 / 34; in 5 of those the true fix was the top real candidate (rank 2 behind the escape), so Choice top-1 among real candidates is 28 / 34. The escape absorbed mass exactly where the Noul p of the true fix was mid-range (0.29–0.74) |
| Requests / cost / latency | 84 requests, **$0.0545**, p50 325 ms, p95 565 ms (requests carried up to 300 Nouls each) |
| p(true fix) under Noul when top-1 | 0.29–0.88 (typical 0.6–0.8). The 8 misses split in two (corrected 2026-09-20 from the raw rows): 3 near misses where the true fix scored mid-range but a wrong candidate scored higher or tied (`kth` 0.48 vs max 0.57, `mergesort` 0.52 tied at rank 1.5, `sieve` 0.41 vs 0.57) and 5 hard misses with the true fix at ≤ 0.19 (`next_palindrome` max 0.08, `shortest_path_length` 0.10, `sqrt` 0.28, `topological_ordering` 0.31, and `next_permutation`, where a wrong candidate `if perm[j] > perm[i]:` reached 0.77). So a 0.25–0.3 threshold flags 2 misses as "not confident", and sends the other 6 to the test oracle with a wrong candidate first |

Per-program rows (Measurement A and B merged; Ochiai rank is Einspect with tie count; Jev ranks are for the
developer fix, p is its probability):

| Program | Fix kind | Operator that reproduces the fix | Cands at buggy line | Cands whole file | Tests pass/fail | Ochiai Einspect rank (ties) | Jev Noul rank (p) | Jev Choice rank (p) |
| --- | --- | --- | ---: | ---: | --- | --- | --- | --- |
| `bitcount` | replace_1 | augassign_swap | 150 | 573 | 0/9 | 2.5 (4) | 1 (0.67) | 1 (0.52) |
| `breadth_first_search` | replace_1 | literal_to_expr | 179 | 4403 | 4/1 | n/a (line not traced) | 1 (0.74) | 1 (0.72) |
| `bucketsort` | replace_1 | ident_subst | 360 | 1893 | 1/6 | 5.0 (5) | 1 (0.80) | 1 (0.84) |
| `depth_first_search` | insert_1 | template:{x}.add({y}) | 0 | 1914 | 4/1 | 1.5 (2) | – | – |
| `detect_cycle` | replace_1 | cond_extend | 138 | 1250 | 5/1 | 4.5 (2) | 1 (0.53) | 2 (0.29) |
| `find_first_in_sorted` | replace_1 | rel_swap | 233 | 2510 | 4/3 | 4.5 (6) | 1 (0.42) | 2 (0.41) |
| `find_in_sorted` | replace_1 | off_by_one | 257 | 2564 | 5/2 | 1.0 (1) | 1 (0.88) | 1 (0.90) |
| `flatten` | replace_1 | call_unwrap | 113 | 900 | 1/6 | 1.0 (1) | 1 (0.87) | 1 (0.62) |
| `gcd` | replace_1 | arg_swap | 250 | 592 | 1/5 | 1.0 (1) | 1 (0.67) | 1 (0.54) |
| `get_factors` | replace_1 | literal_to_expr | 29 | 995 | 1/10 | 1.5 (2) | 1 (0.78) | 1 (0.82) |
| `hanoi` | replace_1 | ident_subst | 329 | 2498 | 1/7 | 2.5 (4) | 1 (0.66) | 1 (0.60) |
| `is_valid_parenthesization` | replace_1 | literal_to_expr | 35 | 797 | 2/1 | 1.5 (2) | 1 (0.84) | 1 (0.92) |
| `kheapsort` | replace_1 | ident_extend | 205 | 1814 | 1/3 | 4.5 (6) | 1 (0.64) | 1 (0.53) |
| `knapsack` | replace_1 | rel_swap | 354 | 4330 | 3/7 | 5.5 (10) | 1 (0.64) | 1 (0.69) |
| `kth` | replace_1 | ident_extend | 291 | 3849 | 3/4 | 1.0 (1) | 2 (0.48) | 1 (0.45) |
| `lcs_length` | replace_1 | off_by_one | 525 | 2554 | 1/8 | 1.5 (2) | 1 (0.53) | 1 (0.42) |
| `levenshtein` | replace_1 | off_by_one | 166 | 1428 | 1/6 | 3.5 (6) | 1 (0.86) | 1 (0.87) |
| `lis` | replace_1 | minmax_wrap | 280 | 3464 | 8/4 | 3.0 (5) | 1 (0.53) | 1 (0.37) |
| `longest_common_subsequence` | replace_1 | ident_extend | 251 | 1401 | 6/4 | 4.5 (8) | 1 (0.53) | 2 (0.31) |
| `max_sublist_sum` | replace_1 | minmax_wrap | 276 | 1175 | 2/4 | 3.5 (6) | 1 (0.82) | 1 (0.84) |
| `mergesort` | replace_1 | boundary_rewrite | 259 | 5278 | 1/13 | 5.0 (3) | 1.5 (0.52) | 1 (0.48) |
| `minimum_spanning_tree` | replace_1 | **none** | 383 | 4250 | 0/3 | 5.0 (9) | – | – |
| `next_palindrome` | replace_1 | off_by_one | 154 | 2105 | 4/1 | 1.0 (1) | 2.5 (0.07) | 3 (0.03) |
| `next_permutation` | replace_1 | operand_swap | 313 | 2594 | 0/8 | 2.5 (4) | 3.5 (0.19) | 5 (0.01) |
| `pascal` | replace_1 | off_by_one | 258 | 2853 | 1/4 | 3.5 (6) | 1 (0.82) | 1 (0.83) |
| `possible_change` | replace_1 | cond_extend | 123 | 1215 | 1/9 | 4.0 (3) | 1 (0.61) | 1 (0.53) |
| `powerset` | replace_1 | prepend_term | 367 | 1133 | 1/4 | 2.0 (3) | 1 (0.70) | 1 (0.37) |
| `quicksort` | replace_1 | rel_swap | 542 | 1818 | 12/1 | 3.5 (6) | 1 (0.29) | 2 (0.24) |
| `reverse_linked_list` | insert_1 | template:{x} = {y} | 0 | 990 | 1/2 | 2.0 (3) | – | – |
| `rpn_eval` | replace_1 | arg_swap | 403 | 5323 | 3/3 | 8.5 (16) | 1 (0.66) | 1 (0.58) |
| `shortest_path_length` | replace_1 | call_to_ident | 935 | 15321 | 2/2 | 8.0 (15) | 63 (0.05) | 69 (0.00) |
| `shortest_path_lengths` | replace_1 | arg_swap | 492 | 3927 | 0/4 | 5.5 (10) | 1 (0.74) | 2 (0.39) |
| `shortest_paths` | replace_1 | **none** | 313 | 3020 | 0/3 | 5.0 (9) | – | – |
| `shunting_yard` | insert_1 | template:{x}.append({y}) | 0 | 2679 | 2/4 | n/a (line not traced) | – | – |
| `sieve` | replace_1 | ident_subst | 468 | 1286 | 1/5 | 1.0 (1) | 3 (0.41) | 5 (0.08) |
| `sqrt` | replace_1 | ident_extend | 309 | 1116 | 1/6 | 2.0 (3) | 42.5 (0.07) | 45 (0.00) |
| `subsequences` | replace_1 | literal_swap | 45 | 2094 | 2/10 | 1.0 (1) | 1 (0.71) | 1 (0.54) |
| `to_base` | replace_1 | operand_swap | 376 | 2252 | 3/7 | 4.0 (7) | 1 (0.61) | 1 (0.68) |
| `topological_ordering` | replace_1 | attr_subst | 600 | 2178 | 0/3 | 3.0 (5) | 27.5 (0.07) | 4 (0.04) |
| `wrap` | insert_1 | template:{x}.append({y}) | 0 | 2345 | 0/5 | 4.0 (7) | – | – |

Of the eight misses, three (`sqrt`: `approx` → `approx ** 2` inside `abs(x - approx)`, `shortest_path_length`:
a call replaced by `distance`, `topological_ordering`: `.successors` → `.predecessors`) need reasoning
about program semantics rather than surface plausibility, and Jev's maximum probability over the whole
candidate set stayed low (0.10–0.31), which is the calibration behaviour REPORT §9 describes: it says
"none of these looks right". That is not universal, though (corrected 2026-09-20): on `next_permutation`
Jev put 0.77 on the wrong candidate `if perm[j] > perm[i]:` (true fix 0.19), and on `kth` and `sieve` a wrong
candidate led at 0.57. Tests would be run on the top-k anyway, so a rank of 27–63 is a budget question
(≈ 60 test runs, seconds on QuixBugs) and a confident wrong pick costs one wasted test run, not a wrong
accept; but the "Jev never picks wrongly with confidence" reading of this probe does not hold.

## 8. Candidate-generation operators and fix templates for the Jev-only agent

Ordered by measured yield on QuixBugs (number of the 38 covered fixes each reproduced) and by the literature
frequency of the corresponding pattern; the second column names the source pattern.

| Operator / template | Literature pattern | QuixBugs fixes reproduced | Expected coverage on one-line bugs |
| --- | --- | --- | --- |
| Off-by-one: `±1` on identifiers, calls, indexes, slice bounds; drop `1 +` | TBar FP9/FP11, SPR value replacement | 5 | high on algorithmic code; "Change Numeric Literal" 4.5 % of SStuBs |
| Identifier substitution (in-scope names, builtins) and attribute/method substitution | TBar FP13 / FP10.1, SStuB "Change Identifier Used" (12.8 %, the most common SStuB), "Wrong Function Name" (5.8 %) | 4 (3 + 1) | the single largest bucket in the wild |
| Identifier extension `X → X[1:] | X[k:] | X ** 2 | X op Y` | TBar FP13.2 (variable → expression) | 4 | medium; explodes with identifier count (`X op Y` is |idents|×3 per identifier) |
| Literal → expression (`True → queue`, `[] → [n]`, `True → depth == 0`) | TBar FP9.2 | 3 | medium |
| Relational operator swap | TBar FP11.1, SStuB "Change Binary Operator" (1.1 %) | 3 | cheap (5 per operator), always include |
| Adjacent argument swap in calls and subscripts | TBar FP10.2, SStuB "Same Function Swap Args" (0.5 %) | 3 | cheap, always include |
| Operand swap `a op b → b op a` | TBar FP11 | 2 | cheap |
| Condition extension `C or not Y` / `C and Y` / `Y is None or C` | TBar FP6.3, SPR condition refinement, SStuB "Less/More Specific If" (0.8 + 0.7 %), Defects4J "Conditional Block" 42.8 % / "Expression Fix" 32.9 % | 2 | the dominant real-world pattern; Jev should rank the disjunct/conjunct (a Choice over in-scope predicates) rather than enumerate blindly |
| `max`/`min` wrap of an assignment or return RHS | TBar FP4.1 / FP12 | 2 | niche but cheap |
| Insertion templates `{x}.append({y})`, `{x}.add({y})`, `{x} = {y}` at a line chosen by Jev | TBar FP4, Defects4J "Missing statement" | 4 | insertions are ~30 % of Defects4J patches; template + Jev-chosen `{x},{y}` is the tractable subset |
| Augmented-assignment / bitwise operator swap | TBar FP11.1 | 1 | rare |
| Call unwrap `f(x) → x`, call → identifier | TBar FP10 / FP13 | 2 | medium |
| Boundary rewrite `== 0 → <= 1` (depth-2 compound) | TBar FP11 + FP9 | 1 | include the few compound forms that recur |
| Prepend term `return Y + E` | TBar FP12 | 1 | rare |
| Literal swap (`[] → [[]]`, `True ↔ False`) | TBar FP9.1, SStuB "Change Boolean Literal" | 1 | cheap |
| None / range guard insertion (`if x is None: return default`, `if i < len(a):`) | TBar FP2 / FP3, Defects4J "Missing Null-Check" 12.7 % | 0 on QuixBugs | essential for real projects, absent from QuixBugs |
| Statement deletion | TBar FP15, Kali | 0 | keep but rank last (Tan anti-patterns; Prophet learned to deprioritise pure deletion) |
| Donor lines from the same file with identifier substitution | plastic surgery (30 % same file), SimFix, ssFix, GenProg copy | not needed on QuixBugs | needed for ~50 % of real bugs whose ingredients exist in the program; the other ~50 % are out of reach |
| Not covered: method call → assignment, two coordinated edits on one line, string edits, type changes | TBar FP7, SPR copy+replace | 2 misses | accept; route to the multi-hunk outer loop |

Candidate-set size is the real constraint: depth-1 alone gives a median of 278 candidates per line and
2,142 per small file; on a 500-line module the whole-file set would be ~50k. Localise first (Jev line
Choice, anchor probe 13/14 top-1; Ochiai as a tie-breaker when passing tests exist), then generate for the
top-3 lines, then rank with Nouls (300 per request, ~$0.0007), then Choice over the top-100, then run
tests on the top-k in rank order.

## 9. Ranking features a calibrated judge could replace

| Feature family in the literature | Where it came from | What Jev asks instead |
| --- | --- | --- |
| Modification-kind × statement-kind features (455 in Prophet), operator frequency priors (CapGen's 30 operators, Astor's commit-mined repair models) | learned from human patches | implicit in the Noul "is this the correct replacement"; can be kept as a code-side prior for ordering candidates within a batch |
| Program-value features (3,060 in Prophet): co-occurrence of abstract variable roles between original and patched code — the features that lifted first-to-validate from 10/19 to 15/19 | learned | the same signal is what Jev evaluates when it reads the test, the buggy line and the candidate together (`hanoi`, `bucketsort`, `sieve`: identifier choice among 300+ candidates, top-1 in two of three) |
| SPR hand-coded prioritisation (prefer condition refinement, deprioritise guards) | engineered | not needed; Jev's ranking was top-1 on 26/34 with zero engineered ordering |
| CapGen genealogy / variable / dependency context similarity between ingredient and target | engineered similarity | Noul per donor: "does `donor` belong at `site` given `program`", or a Choice over donors |
| SimFix / ssFix syntactic similarity of donor snippets | TF-IDF / AST similarity | code-side pre-filter (keep top-255 by similarity), then Jev Choice |
| Anti-patterns (Tan et al.): deletes an exit, adds a trivial condition, removes a loop update | rules | Nouls on the candidate: "does this delete functionality the tests exercise", "is the added condition always true"; the JevCode risk stage already asks these |
| Patch-correctness classifiers (ODS, Invalidator, embeddings of code changes) | supervised on plausible patches | Noul after tests pass: "given `failing_test_before`, `diff`, `tests_after`, is the change a genuine fix rather than a test-specific workaround" — the missing piece between plausible and accepted |
| Test-based overfitting checks (EvoSuite regression tests 98.2 % accuracy, Opad fuzzing 75 %) | dynamic | keep them; they are the oracle. Jev only decides which candidates deserve a test run and in what order |

## 10. What this means for the design

1. **The literature's bottleneck is exactly the slot Jev fills.** Every generate-and-validate system that
   improved on GenProg did so by ranking (Prophet 11.5 % vs random 41.8 % mean rank; CapGen ranks the
   correct patch before 98.78 % of plausible-incorrect ones) or by shrinking the space (SPR's target-value
   search, SimFix's intersection). Measured here: Jev with one Noul per candidate ranks the developer fix
   top-1 in 26/34 and top-5 in 31/34 over a mean of 295 candidates, MRR 0.83, for $0.0016 per program,
   with no training, no features and no heuristics. The rate is in Prophet's range (first-to-validate
   correct 15/19 = 79 % vs 26/34 = 76 % here), but the settings are not comparable: Prophet ranks a whole
   search space over real C defects with its own localisation, while this probe is given the true line and
   a candidate set that contains the developer fix by construction, on toy programs. Read it as "strong
   enough to build the loop on", not as parity with Prophet (qualified 2026-09-20).
2. **Adopt "rank → validate in rank order → stop at first plausible → judge before accepting".** With
   53 % of plausible QuixBugs patches overfitting (Ye et al.), tests alone are not the acceptance step.
   Add a post-plausible Noul ("genuine fix vs test-specific") and the anti-pattern Nouls; both are cheap and
   the JevCode risk/judge stages already have the shape.
3. **Use the operator catalogue in Section 8 as the first candidate source.** Depth-1 operators and a
   dozen insertion templates reproduce 38/40 QuixBugs fixes (in-sample). Order generation by yield
   (off-by-one, identifier/attribute substitution, identifier extension, literal→expression, relational
   swap, argument swap) and cap the set at ~300 per line; identifier extension and `X op Y` are the
   ones that blow up and should be gated by a Jev Choice over in-scope identifiers.
4. **Localise with Jev, tie-break with Ochiai.** On QuixBugs Ochiai is top-1 on 7/38 buggy lines (heavy
   ties; 7 programs have no passing test), against Jev's 13/14 top-1 in the anchor probe. On real Python
   projects SBFL is top-1 on 12 % (Rezaalipour & Furia, 135 BugsInPy bugs) and top-5 on 14 % (Widyasari
   et al., 493 BugsInPy bugs). Run tests under coverage anyway: the executed-line
   set prunes candidate lines by 3–5× and the pass/fail deltas after applying a candidate are the progress
   signal.
5. **Insertions and multi-edit lines need the grammar path.** Four QuixBugs fixes are one-line insertions
   (all matched by templates with two identifier slots); ~30 % of Defects4J patches are pure additions.
   Template + Jev Choice over `{x},{y}` slots is the tractable form of "generation as a sequence of
   Choices"; the two uncovered QuixBugs fixes and anything with two coordinated edits should go to the
   outer per-failing-test loop rather than a bigger operator set.
6. **Expect the real-project ceiling to be set by ingredients, not by ranking.** Half of Defects4J bugs
   need donor code that is not in the program (Yang et al. 2021); same-file grafts cover 30 % of donor
   snippets (Barr et al.). For SWE-bench that means the Jev-only condition should be measured on the
   subset whose gold patch is a one- or two-line edit inside an existing function, and report the rest as
   out of scope by construction.
7. **Thresholds** (corrected 2026-09-20 against the raw rows). Under Noul ranking the true fix had
   p ≥ 0.29 whenever it was top-1. Among the 8 misses the true fix scored 0.07–0.52 and the leading wrong
   candidate 0.08–0.77 (`next_permutation` 0.77, `kth` and `sieve` 0.57, `topological_ordering` 0.31,
   `sqrt` 0.28). A "run tests on everything above 0.25, else widen localisation" rule would have fixed
   26/34 on the first test run, wasted a first test run on a wrong candidate for 6 programs (the oracle
   catches them), and flagged 2 (`next_palindrome`, `shortest_path_length`) as "nothing confident". The
   threshold therefore buys budget control, not protection against confident wrong picks; there is no
   p-cut that separates the 26 hits from `next_permutation`. Choose it from your own plot (REPORT §14).
   Also note the 5-program re-run below: mid-range probabilities move by up to 0.3 when the candidate
   order/keys change, so thresholds should be set with a margin, not at a single observed boundary.

## 11. Costs and limits of this survey

- Jev spend for this topic: $0.0545 (84 requests, p50 325 ms with 300-Noul batches, p95 565 ms). Operator
  coverage and SBFL runs cost nothing. Combined with the anchor probe ($0.0009) the Jev-only track is at
  $0.056 of the $1.00 cap.
- Measurement A's catalogue is fitted to QuixBugs (two extension rounds); Measurement B gives Jev the true
  line and includes the developer fix in the set by construction; whole-file ranking (2k–15k candidates
  without localisation) was not measured. Ochiai ranks use Einspect tie handling; 2 buggy lines were not
  traceable (`breadth_first_search`: `while True:` header; `shunting_yard`: insertion point never executed by the buggy program).
- Tan et al.'s per-anti-pattern definitions were read from the paper's prevalence table only; Refactory's
  per-configuration numbers (64.5 % / 81.4 % / 90.8 %) are from its Table II as extracted. Astor's 98/357
  is plausible patches, not correct ones. Angelix's 28/32 is within its own "defect class".

## Verification (2026-09-20)

Adversarial re-check of this file, its two scripts and the saved raw outputs. Checker spend: $0.012 (two
5-program live re-runs, 24 requests, `usage.costUsd`). Nothing under `src/` or `docs/` was touched; the only
script change is two env hooks in `jev-rank-probe.mts` (`PROGRAMS=` filter, `OUT=` file) and seeding the
shuffle by position in the full list so filtered re-runs reproduce the original candidate order.

### Numbers recomputed from the saved raw outputs

| Claim in this file | Recomputed from `jev-rank-results.json` / `quixbugs-operator-coverage.json` | Status |
| --- | --- | --- |
| n = 34; Noul top-1 26, top-5 31, top-10 31, MRR 0.831 | 34; 26 / 31 / 31; 0.831 (ties get the average rank, `mergesort` at 1.5 counts as a miss) | correct |
| Choice top-1 23, top-5 32, MRR 0.780 | 23 / 32 / 0.780; but 9/34 argmaxes were `none_of_these`, 5 of them with the true fix at rank 2 | correct, nuance added to §7 |
| 84 requests | Σ over programs of ceil(n/300) + 1 = 84 | correct |
| Mean 295 candidates, range 28–934 | 295.0; 28–934 (Measurement A counts are +1 because the probe drops the empty "delete" candidate) | correct |
| Shortlist never cut the true fix, "0 / 12 programs > 254" | 0 cuts, but 20 programs had > 254 candidates, not 12 | corrected |
| Cost $0.0545, p50 325 ms, p95 565 ms | the script sums `usage.costUsd` and sorts latencies; no per-request log is saved, so the total cannot be recomputed independently. Re-run: 12 requests cost $0.0060 (~$0.0005 each), consistent with $0.0545 / 84 | plausible, not independently recomputable |
| Coverage 38/40; 36 replace_1 + 4 insert_1; uncovered `minimum_spanning_tree`, `shortest_paths` | 38/40; 36 + 4; same two | correct |
| Median candidates 278 per buggy line, 2,142 per file; max 935 / 15,321 | 278.0 (n = 36 lines) / 2,141.5 / 935 / 15,321 | correct |
| Ochiai ≤ 1: 7/38, ≤ 3: 19/38, ≤ 5: 34/38, ≤ 10: 38/38, mean 3.26; worst-case ≤ 1: 7, ≤ 5: 21; DStar 7 / 34; Tarantula 4 / 34; 7 programs with zero passing tests | all identical | correct |
| "2 buggy lines never traced (`while True:`)" | `breadth_first_search` yes; `shunting_yard` is an insertion whose site (L17–18) the buggy program never executes | corrected |
| §8 per-operator yield column (5, 4, 4, 3, 3, 3, 2, 2, 2, 4, 1, 2, 1, 1, 1) | sums to 38 and matches `covered_by` counts | correct |
| "misses have p ≤ 0.19, max ≤ 0.57", "no confident wrong pick" (§7 table, §7 prose, §10.7) | false: `kth` 0.48, `mergesort` 0.52, `sieve` 0.41 are misses; `next_permutation` put 0.77 on a wrong candidate | corrected in all three places |

### Does the probe do what the table says? Live re-run, 5 programs, ≤ $0.10

Same script, same model id, same state shape. Run 1 reused the author's shuffle (seeded by position in the
full list); run 2 used a different shuffle (candidate order and `cand_NNN` keys differ, content identical).

| Program | Original Noul rank (p; max) | Re-run, same order | Re-run, reshuffled | Choice rank orig / same / reshuffled |
| --- | --- | --- | --- | --- |
| `bitcount` | 1 (0.67; max 0.67) | 1 (0.70; max 0.70) | 1 (0.70; max 0.70) | 1 / 1 / 1 |
| `gcd` | 1 (0.67; max 0.67) | 1 (0.75; max 0.75) | 1 (0.61; max 0.61) | 1 / 1 / 1 |
| `kth` | 2 (0.48; max 0.57) | 2 (0.48; max 0.63) | 6 (0.14; max 0.56) | 1 / 1 / 7 |
| `next_permutation` | 3.5 (0.19; max 0.77) | 4 (0.19; max 0.73) | 2 (0.52; max 0.72) | 5 / 8 / 3 |
| `sqrt` | 42.5 (0.07; max 0.28) | 49 (0.06; max 0.40) | 76.5 (0.04; max 0.30) | 45 / 50 / 80 |

Reading: with identical state the answers are stable (all top-1 outcomes and near-miss ranks reproduce,
p moves ≤ 0.12). With the candidates merely reordered and re-keyed, mid-range items move a lot: `kth` true
fix 0.48 → 0.14 (rank 2 → 6), `next_permutation` 0.19 → 0.52 (rank 3.5 → 2), `sqrt` rank 42.5 → 76.5.
REPORT §7 found option order irrelevant for small informative Choices; a state with 300 near-duplicate
candidate strings is a harder case, and here order/key assignment matters more than sampling noise. The
26/34 is therefore one draw; expect roughly ±2–3 across shuffles, concentrated on the near-miss programs.
Not measured at full scale (would cost ~$0.05 per extra shuffle; left for the design phase).

### Are the Jev questions well-formed (REPORT §10–11, §14)?

- Noul per candidate: `contextNoul` (instructions only) with criteria placed once in the state as
  `what_correct_means` + `not_correct` list + `correct_examples`. Definition and both sides are present; the
  false side has a list but no worked examples. Target named by backticked path (`candidates.cand_017`,
  `buggy_line`, `tests`, `criteria`); "answer carefully and literally" appended. No counting, arithmetic
  or date comparison is asked. Acceptable; a `not_correct_examples` list would complete the REPORT recipe.
- Choice: escape option `none_of_these` present (via `choice()`); ≤ 254 real options + escape; option
  descriptions are `null` and keys are positional (`cand_NNN`), so the model must resolve the key through
  the state. REPORT §10 says descriptions matter more than keys; the 9/34 escape argmaxes suggest the Choice
  form is the weaker of the two here, which the file's own numbers (Noul MRR 0.83 vs Choice 0.78) show.
- Fairness: the true fix is appended to the candidate list only if missing (never triggered: all 34 were
  covered) and to the shortlist only if cut (never triggered, `cut_by_noul_top100` = 0). Tests shown to Jev
  are the first 4 JSON cases (or 2,500 chars of the pytest file), not the full suite; the Noul asks about
  "all `tests`", which is the shown subset.

### Literature spot-checks (re-fetched 2026-09-20)

| Source | Checked | Result |
| --- | --- | --- |
| Prophet, [people.csail.mit.edu/fanl/papers/prophet-popl16.pdf](https://people.csail.mit.edu/fanl/papers/prophet-popl16.pdf) | 3515 features = 455 + 3060; 777 training patches; 19/69 in space; 18/19 found; first-to-validate 15/19 (SPR 11, Random 7, Baseline 8); mean rank top 11.5 % (Random 41.8 %, SPR 17.5 %); no-program-value variant 18 found / 10 first; GenProg 1, AE 2, Kali 2 correct | all confirmed verbatim |
| CapGen, [tjusail.github.io/.../ICSE18.pdf](https://tjusail.github.io/people/chenjunjie/files/ICSE18.pdf) | "plausible patches for 25 bugs and 21 of them are correct ... precision of 84.00 %"; 98.78 % (164/166); 40.00 % (10/25); 21 of the 22 bugs in Table 3 | 22 correct → 21 corrected; rest confirmed; 69.69 % not found in extracted text |
| Widyasari et al. EMSE 2022 (PDF as linked) | Ochiai top-5 14.19 %, top-10 19.87 %, top-200 50.30 %; Defects4J 32.41 / 42.53 / 81.77 %; 493 faults; DStar 9.53 % top-5 | all confirmed |
| arXiv 2305.19834 | title "An Empirical Study of Fault Localization in Python Programs", authors Rezaalipour & Furia, 135 BugsInPy faults, EMSE 2024 | file said "Rees-Jones et al."; corrected. Top-N percentages not re-verified |
| All 14 arXiv IDs cited | resolved via arxiv.org/abs titles | every ID matches the paper it is cited for |

Not re-verified (taken as the author extracted them): GenProg TSE 2012, RSRepair, SPR, Angelix, TBar and
kPAR counts, SimFix, ssFix, ARJA, Refactory, Astor 98/357 and its filter numbers, Long & Rinard 2016 quotes,
Barr et al., Martinez et al., Yang et al. 2021, Sobreira et al., Karampatsis & Sutton percentages,
Pearson et al., Smith et al., Ye et al. per-tool counts, Tan et al., CURE, CoCoNuT, DeepDebug, Codex,
AlphaRepair, ChatGPT, ChatRepair. URLs and fetch dates are given for each; the author's own caveats on
Tan, Refactory, Astor and Angelix stand.

### Conclusions: supported or overreaching

- Supported by the raw data: 38/40 in-sample operator coverage (with the in-sample caveat), Ochiai's weak
  top-1 on QuixBugs, Noul ranking top-1 26/34 / MRR 0.83 for one shuffle, cost and latency figures,
  the rank → validate → judge loop as the literature's pattern, ingredient-locality limits.
- Overreaching, now qualified: "Prophet-class ranking" (different benchmark, true line given, fix in the
  set by construction); "Jev does not confidently pick a wrong candidate" (0.77 on `next_permutation`);
  the threshold rule in §10.7 (no p-cut separates hits from the confident miss; the rule buys budget
  control only); stability of the 26/34 (order-sensitive on near misses).
- Verdict: **corrected**. The measurements are real and reproducible, the headline ranking numbers hold,
  and the survey citations that were spot-checked are accurate to the digit except one count and one
  author name; the interpretive claims about calibration and thresholds were not supported by the file's
  own rows and have been rewritten.
