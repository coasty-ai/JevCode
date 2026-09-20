# Oracle from the issue: a failing behaviour for the Jev-only search on SWE-bench Verified (2026-09-20)

Model `typesafe/jev-1.13-20260917` via OpenRouter, pinned. No generating LLM anywhere: code extracts the candidate
snippets, Jev answers Nouls/one Choice over them, code builds and evaluates the pass criterion. Three full live runs
of the 30 instances: **23 Jev requests per run, $0.0032 per run ($0.0096 total, plus $0.00 for two hand-label runs), p50
latency 189–196 ms, max 865 ms, largest request 11,755 input tokens (median 2,535), 27–42 s wall per run** including
every Python execution. Results: `experiments/oracle/results.json` (run 3, the one reported), `results.run1.json`,
`results.run2.json`, `results.labels.json` (hand labels in place of Jev), `table.md`, `labels.json` (hand labels,
written from the extractor's block list before any Jev call). Script: `experiments/oracle/run.mts`. Module:
`src/synth/oracle/` (extract.ts, questions.ts, runner.ts, goal.ts, types.ts, index.ts; 69 unit tests in
`test/unit/synth/oracle/`).

## Why

Every SWE-bench instance in `bench/results/jev-only-swebench-1/tasks.jsonl` ended with an empty patch: the agent gets
the issue text, the FAIL_TO_PASS tests are applied only by the evaluator, so the design's search
(`docs/JEV-ONLY-DESIGN.md` §1–§2: goals = clusters of failing tests) had no goal. The transcripts show it: `synth
baseline: 0/1 pass, 0 failed, 1 errors` → `every goal parked: no goal` → nine blocked `run` proposals →
`replan_stop` ($0.015, 19 s, sympy-12096). This round asks whether the issue text itself yields an oracle: a snippet
that fails at `base_commit` by a code-computed criterion and passes once the gold patch is applied.

## Headline

| Question | Result (run 3, Jev) | With hand labels instead of Jev |
| --- | --- | --- |
| (a) instances with ≥ 1 extracted snippet | **23/30** (7 have no code at all: sympy-12489, django-15572/-16100/-14725/-15103, pylint-4970, requests-1142) | same (code) |
| (b) Jev's `is_reproduction` pick is in the hand-label set | 15/23 picks; the ≥ 0.5 set equals the label set on 18/23; `shows_expected` pick in labels 20/23; `failure_kind` 21/23 strict, 22/23 lenient | – |
| (c) script runs at base and FAILS by the code criterion | **13/23** reached the runner; 11 fail on base, 2 pass on base (bad oracle), 0 environment errors at the runner level | 15 reached; 14 fail, 1 passes |
| (d) **decisive: fails on base ∧ passes on gold** | **9/30 = 7 strong + 2 weak** (sympy-15345, -17139, -19954, -11618, django-15315, -15128, requests-2931; weak: sympy-12096, django-15563); 4 fail on gold too (all incomplete snippets or missing toolchain) | **10/30 = 8 strong + 2 weak** (+ sympy-20428, whose right transcript Jev did not pick) |
| (e) cost and time | $0.0032 Jev per full pass over 30 instances; 27–42 s wall; base runs median 608 ms (max 6.3 s, sympy-20428); gold re-runs median 552 ms | $0.00, 20 s |

Reading: **a Jev-only agent now has a goal on 9 of the 30 instances (30 %)**, at one request and about $0.00014 per
instance, and on the 23 instances with any code the pipeline is right or honestly empty everywhere except two
(sympy-22080, pylint-4604: a criterion that passes on base). The oracle validity check against gold is 9/11 on the
Jev picks that failed on base; the two misses (plus two more that fail both ways) are the reporter's snippet missing
names the library does not export (`wraps`, `Book`, `Expression`) or a toolchain we do not have (Cython).

## What "valid" means here, per outcome class

| Outcome | Definition | n (Jev) | Instances |
| --- | --- | --- | --- |
| `valid` | criterion built from a stated expected value or exception; fails at base, passes with gold | 7 | sympy-15345 (`values`, loose tier), -17139, -19954, django-15315, -15128, requests-2931 (`no_exception`), sympy-11618 (`values`) |
| `valid_weak` | no expected value stated anywhere: criterion = "last value differs from the observed wrong one and nothing raises"; fails at base, passes with gold | 2 | sympy-12096 (`f(g(2))` → `16.0000000000000`), django-15563 (`[55, 55]` → `[100, 101]`) |
| `fails_on_gold` | fails at base but also after gold: not an oracle | 4 | sympy-16792 (Cython build: `CodeWrapError`), sympy-20428 (Jev picked the set-up transcript, block 0 at 0.86; the `bad_poly.rep` transcript, block 5, sat at 0.28), django-15375 (`Book` is the reporter's model, never defined), pytest-7324 (`Expression` is not exported by `_pytest`) |
| `passes_on_base` | criterion passes at base: the snippet does not show the bug as run | 2 | sympy-22080 (weak criterion: this base prints `return -x % y` where the reporter's version printed `return (-x % y)`, so "differs" is met by formatting drift), pylint-4604 (a module to *lint*; running it defines two names and raises nothing; Jev said `exception_raised` 0.55, label `wrong_value`) |
| `not_runnable` | Jev's top block is a test module (pytest/unittest) that needs a command oracle, not a statement runner (code-detected `isTestModule`) | 3 | pytest-10081, -7205, -10051 |
| `no_pick` | no runnable block at `is_reproduction` ≥ 0.5 | 5 | sympy-13798 (feature request: 0.14, correct), django-14787 (0.41), django-15916 (0.49; the snippet has a typo `form django.db import`), pytest-10356 (0.49/0.45; test file), pylint-6386 (0.37; shell command) |
| `no_blocks` | nothing to run | 7 | see (a) |

Stability across the three Jev runs (same code from run 2 on; run 1 predates two fixes): outcomes identical on 24/30;
sympy-20428 `passes_on_base` → `fails_on_gold` ×2 (Jev's `failure_kind` moved 0.50 `exception_raised` → 0.54
`wrong_value`), django-15916 `no_pick`/`no_criterion`/`no_pick` (0.49 → 0.52 → 0.49 on one Noul), the three pytest
rows moved from `passes_on_base` to `not_runnable` when the test-module check landed (run 1 → 2), and pytest-10051
followed in run 3 after the check learnt `def test(` without an underscore. No picked block's probability moved by
more than 0.10 between runs. One anomaly to record: in one of the two hand-label runs django-15315 passed at base;
the worktree was clean afterwards, no `__pycache__` existed under the clone, and the next run and a direct re-run
fail at base again. Unexplained; the likeliest cause is concurrency: another agent's bench was running during this
session (`~/.jevcode/runs/bench-work` grew from 21 to 28 run directories) and `run.mts` picks the *newest* bench-work
venv per instance, so a venv mid-build or a workspace mid-patch may have been chosen for that one run. `run.mts` now
refuses a dirty worktree before every base run (the `/tmp/jevonly/repos` worktrees are also shared with the design's
R4 experiment); pinning the venv choice to a completed run directory is the remaining hardening.

## Per instance (run 3)

Columns: blocks code extracted (kinds); Jev's reproduction pick with P and the hand-label set; `shows_expected` pick;
`failure_kind` with P and label; criterion form; verdict at base / with gold (observed value); outcome; Jev input
tokens / cost / latency; wall seconds for the instance including the Python runs.

| instance | blocks (kinds) | Jev is_repro pick p / label set | shows_expected pick / label | failure_kind (p) / label | criterion | base | gold | outcome | Jev tokens / $ / ms | wall s |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| sympy__sympy-12096 | 1 (repl) | 0 (0.94) / [0] | none / [] | wrong_value (0.85) / wrong_value | differs_from_actual (weak) | FAIL: f(g(2)) | pass: 16.0000000000000 | **valid_weak** | 1778 / $0.0001 / 200 | 0.9 |
| sympy__sympy-15345 | 1 (code) | 0 (0.72) / [0] | none / [] | wrong_value (1.00) / wrong_value | values | FAIL: 'Max(2, x)' | pass: 'Max[2, x]' (loose tier) | **valid** | 1338 / $0.0001 / 137 | 3.1 |
| sympy__sympy-17139 | 1 (repl) | 0 (0.89) / [0] | none / [] | exception_raised (1.00) / exception_raised | no_exception | FAIL: TypeError: Invalid comparison of complex I | pass: cos(x)**I | **valid** | 6857 / $0.0003 / 283 | 6.6 |
| sympy__sympy-19954 | 3 (code, traceback, code) | 0 (0.92) / [0, 2] | none / [] | exception_raised (1.00) / exception_raised | no_exception | FAIL: IndexError: list assignment index out of range | pass | **valid** | 3599 / $0.0002 / 201 | 3.5 |
| sympy__sympy-11618 | 1 (repl) | 0 (0.74) / [0] | none / [] | wrong_value (1.00) / wrong_value | values | FAIL: 1 | pass: sqrt(5) | **valid** | 1388 / $0.0001 / 208 | 2.0 |
| sympy__sympy-13798 | 2 (repl, repl) | none (max 0: 0.14) / [] | 0 (0.80) / [0] | none_of_these (0.91) / none_of_these (+wrong_value) | - | - | - | **no_pick** | 2253 / $0.0001 / 186 | 0.2 |
| sympy__sympy-16792 | 4 (code, code, output, code) | 0 (0.94) / [0] | 3 (0.53) / [] | exception_raised (0.95) / exception_raised (+wrong_type) | no_exception | FAIL: CodeWrapError (Cython build) | FAIL: CodeWrapError | **fails_on_gold** | 3801 / $0.0002 / 128 | 2.6 |
| sympy__sympy-20428 | 7 (repl ×7) | 0 (0.86) / [1, 2, 5] | 6 (0.97) / [6] | wrong_value (0.54) / wrong_value (+exception_raised) | values | FAIL: Poly(0, x, domain='EX') | FAIL: Poly(0, x, domain='EX') | **fails_on_gold** | 11755 / $0.0005 / 299 | 11.7 |
| sympy__sympy-22080 | 1 (repl) | 0 (0.86) / [0] | none / [0] | wrong_value (1.00) / wrong_value | differs_from_actual (weak) | pass: 'def _lambdifygenerated(x, y):⏎    return -x % y⏎' | - | **passes_on_base** | 1866 / $0.0001 / 255 | 1.5 |
| sympy__sympy-12489 | 0 | - | - | - | - | - | - | **no_blocks** | - | 0.0 |
| django__django-14787 | 1 (code) | none (max 0: 0.41) / [0] | none / [] | exception_raised (1.00) / exception_raised | - | - | - | **no_pick** | 1532 / $0.0001 / 170 | 0.2 |
| django__django-15315 | 1 (code) | 0 (0.86) / [0] | none / [] | exception_raised (1.00) / exception_raised | no_exception | FAIL: AssertionError | pass | **valid** | 1491 / $0.0001 / 236 | 1.2 |
| django__django-15572 | 0 | - | - | - | - | - | - | **no_blocks** | - | 0.0 |
| django__django-16100 | 0 | - | - | - | - | - | - | **no_blocks** | - | 0.0 |
| django__django-14725 | 0 | - | - | - | - | - | - | **no_blocks** | - | 0.0 |
| django__django-15103 | 0 | - | - | - | - | - | - | **no_blocks** | - | 0.0 |
| django__django-15375 | 2 (repl, repl) | 1 (0.81) / [1] | 0 (0.95) / [] | exception_raised (1.00) / exception_raised | no_exception | FAIL: NameError: name 'Book' is not defined | FAIL: same | **fails_on_gold** | 3177 / $0.0001 / 152 | 1.1 |
| django__django-15563 | 2 (code, repl) | 1 (0.70) / [1] | none / [] | wrong_value (0.97) / wrong_value | differs_from_actual (weak) | FAIL: <QuerySet [{'field_otherbase': 55}, {'field_otherbase': 55}]> | pass: <QuerySet [{'field_otherbase': 100}, {'field_otherbase': 101}]> | **valid_weak** | 3174 / $0.0001 / 191 | 1.5 |
| django__django-15916 | 1 (code) | none (max 0: 0.49) / [0] | none / [] | wrong_value (0.87) / wrong_value (+none_of_these) | - | - | - | **no_pick** | 1777 / $0.0001 / 196 | 0.2 |
| django__django-15128 | 1 (code) | 0 (0.75) / [0] | none / [] | exception_raised (1.00) / exception_raised | no_exception | FAIL: AssertionError | pass: <QuerySet []> | **valid** | 2231 / $0.0001 / 865 | 1.9 |
| pytest-dev__pytest-10081 | 5 (code, output, output, traceback, output) | none (max 0: 0.68, a test module) / [0] | 2 (0.96) / [2] | exception_raised (1.00) / none_of_these (+exception_raised) | - | - | - | **not_runnable** | 5254 / $0.0002 / 189 | 0.2 |
| pytest-dev__pytest-7205 | 2 (code, traceback) | none (max 0: 0.71, a test module) / [0] | none / [] | exception_raised (1.00) / exception_raised | - | - | - | **not_runnable** | 8438 / $0.0004 / 196 | 0.2 |
| pytest-dev__pytest-10051 | 2 (code, output) | none (max 0: 0.92, a test module) / [0] | none / [] | exception_raised (0.94) / exception_raised (+wrong_value) | - | - | - | **not_runnable** | 2535 / $0.0001 / 215 | 0.2 |
| pytest-dev__pytest-7324 | 1 (repl) | 0 (0.64) / [0] | none / [] | exception_raised (0.91) / exception_raised (+none_of_these) | no_exception | FAIL: NameError: name 'Expression' is not defined | FAIL: same | **fails_on_gold** | 1645 / $0.0001 / 192 | 0.5 |
| pytest-dev__pytest-10356 | 2 (code, code) | none (max 0: 0.49) / [0, 1] | none / [] | wrong_value (0.91) / wrong_value (+none_of_these) | - | - | - | **no_pick** | 3599 / $0.0002 / 193 | 0.2 |
| pylint-dev__pylint-4970 | 0 | - | - | - | - | - | - | **no_blocks** | - | 0.0 |
| pylint-dev__pylint-4604 | 3 (code, output, output) | 0 (0.90) / [0] | none / [] | exception_raised (0.55) / wrong_value (+none_of_these) | no_exception | pass: 'Docstring.' | - | **passes_on_base** | 2810 / $0.0001 / 177 | 0.3 |
| pylint-dev__pylint-6386 | 3 (output ×3) | none (max 0: 0.37) / [0] | none / [] | exception_raised (0.80) / exception_raised (+wrong_value) | - | - | - | **no_pick** | 2826 / $0.0001 / 182 | 0.2 |
| psf__requests-1142 | 0 | - | - | - | - | - | - | **no_blocks** | - | 0.0 |
| psf__requests-2931 | 1 (code) | 0 (0.85) / [0] | none / [] | exception_raised (1.00) / exception_raised | no_exception | FAIL: UnicodeDecodeError: 'ascii' codec can't decode byte 0xc3 | pass: <Response [200]> | **valid** | 1357 / $0.0001 / 206 | 0.8 |

Hand-label mode (`--labels`, Jev replaced by the label sets at 0.95/0.05): sympy-20428 becomes `valid` (block 5
`bad_poly.rep` vs block 6 `DMP([], EX, None)`, base `DMP([EX(0)], EX, None)`), django-14787 runs and fails both ways
(`NameError: method_decorator`/`wraps`: the snippet never imports them and `django` does not export them),
pylint-4604 has no criterion (label `wrong_value`, no expected value); everything else is unchanged. Totals: 8 + 2 weak
valid, 1 passes on base, 4 fail on gold, 5 not runnable, 1 no pick, 2 no criterion, 7 no blocks.

## The Jev questions, measured

One request per instance (23 requests): per block `is_reproduction_<i>`, `shows_expected_<i>`, `shows_actual_<i>`
(Nouls with definition + two examples per side), one Choice `failure_kind` over
`wrong_value | exception_raised | should_raise_but_does_not | wrong_type | performance | none_of_these`, and per
traceback frame `frame_in_fix_<k>` (frames folded by file+function, the reporter's `<stdin>` dropped, ≤ 24). State:
`{ issue: { repository, problem_statement }, blocks: { block_i: { kind, found_as, text, statements?, exceptions? } },
frames?: { frame_k: { file, line, function, code? } } }`. Exact wording in `src/synth/oracle/questions.ts`.

- `is_reproduction`: the ≥ 0.5 set equals the hand-label set on 18/23. The five disagreements are all *under*-calls
  on runnable code: django-14787 0.41 (bare code with an undefined `wraps`), django-15916 0.49 (a typo'd snippet),
  pytest-10356 0.49/0.45 (a test file), pylint-6386 0.37 (a shell command block: `pylint mytest.py -v`), and
  sympy-20428 where the set-up transcript (0.86) outranks the three transcripts that show the bug (0.53 / 0.47 /
  0.28). No over-call: no `output`, `traceback` or version-listing block reached 0.5 (max 0.14 on the pip listings
  and 0.41 on the `--pdb` transcript of pytest-10081). Lowering the threshold to 0.35 would add four picks, none of
  which can become a valid oracle with this runner (missing names, a typo, a test file, a shell command).
- `shows_expected`: pick in the label set on 20/23; the three misses are sympy-16792 (0.53 on the *working* variant,
  which is expected behaviour of a different call), sympy-22080 (a transcript that shows both the right and the wrong
  value: 0.17, label yes) and django-15375 (0.95 on the working call before the crash, label no). Where a separate
  expected block exists (sympy-20428 block 6) Jev found it at 0.97.
- `failure_kind`: 21/23 strict, 22/23 lenient. The two errors are pytest-10081 (`exception_raised` 1.00 where the
  behaviour is "teardown runs when skipped"; lenient-accepted) and pylint-4604 (`exception_raised` 0.55 for a false
  positive lint message). The kind decides the criterion form, so these are the cases where a wrong kind would
  produce a wrong criterion; both were caught (the first is not runnable, the second passes on base).
- `frame_in_fix` (localisation anchor): 5 instances offered frames. sympy-17139: `fu.py::_f` 0.96, `fu.py::TR6`
  0.63, `fu.py::_TR56` 0.62 — the gold function is `_TR56` in `fu.py` (probe Q2 truth `tr56`), every frame outside
  `fu.py` ≤ 0.51. sympy-19954: `perm_groups.py::minimal_blocks` 0.93 (gold function), `sylow_subgroup` 0.61.
  pytest-7205: `setuponly.py:69` 0.95 (the gold file and line), `pytest_fixture_setup` 0.58, `fixtures.py::execute`
  0.22, the pluggy/runner plumbing ≤ 0.22. sympy-20428: nine polys frames all 0.48–0.65 with the gold file
  (`expressiondomain.py`) absent from the traceback — a flat, uninformative profile rather than a false anchor.
  pytest-10081: the only frame is the reporter's test file at 0.05 (correct). So on 3/3 instances whose traceback
  contains the gold file, the top frame is in it; the anchor is worth feeding to `localize/` as `TracebackFrame`s.

## Code, not Jev: what the runner does and where it fell short

- **Extraction** (`extract.ts`): fences, `>>>` and IPython `In [n]:` transcripts (split into statements with the shown
  output per statement; `Out[n]:` prefixes stripped; a trailing `# comment` removed from a single shown line),
  Python- and pytest-style tracebacks (frames with file/line/function/code, exception type + message), bare
  exception lines, and **bare code runs** for Django's Trac (which strips markdown: django-15128, -15315, -14787,
  -15916 have their code at column 0 with tab-indented bodies) plus sentences matching expected/should/instead
  of/but got/returns/raises with their backticked or quoted values. 23/30 instances yield ≥ 1 block, 76 blocks in all.
  One extraction bug found and fixed on the real texts: pytest's `>>>>>>>> traceback >>>>>>>>` separators read as
  prompts.
- **Runner** (`runner.ts`): the script splits each chunk with `ast`, runs statements one at a time in a shared
  namespace, records `repr()` of expression values, stdout, `type(value).__name__`, exceptions with frames; `sys.path`
  gets `<workspace>/src` and `<workspace>` first (load-bearing: requests is installed non-editable in its venv);
  30 s timeout; nothing written to disk (base64 in the command); `.venv/bin/python` if present else `python3`. Two
  bounded fix-ups were needed to run reporters' snippets as written: a `NameError` retry that binds a name the
  repository's top-level package exports or an importable module (`from sympy import symbols; Max; mathematica_code;
  Point`, `import inspect`; 4 instances used it), and a Django preamble (`settings.configure` with in-memory sqlite,
  an app labelled `app` for models the snippet defines with tables created as they appear, `models`/`forms`/`admin`
  bound on demand) without which none of the four Django snippets runs. A statement that fails on a module the
  repository does not provide (`numpy`, `bug.app.models`, `example.core.models`) or on the network is marked
  `environment` and never counts as evidence. pytest's clone needed a generated `src/_pytest/_version.py`
  (setuptools_scm writes it at install time); `run.mts` writes it and says so.
- **Criterion** (`buildCriterion`/`evaluateCriterion`, all code): `exception_raised` → no uncaught exception (6 of
  the 9 valid); `wrong_value` with a stated expected value → normalised equality (whitespace, quotes, trailing zeros
  `4.00000000000000` = `4.0`, dict key order, `0x…` addresses, repr `\n` escapes) at the last statement, or per
  statement when the reproduction itself shows the expected values, or against a separate expected block's last shown
  value; `should_raise_but_does_not` → exception-type equality; `wrong_type` → `type(...)` name. One **loose tier**
  was added after run 1: sympy-15345's reporter wrote `'Max[x,2]'` and the printer emits `'Max[2, x]'` (canonical
  argument order), so a `values` criterion also passes on the same token multiset in another order *provided* the
  value differs from the recorded wrong one (`observedActual`); 1/9 valid oracles rests on it. When no expected value
  exists anywhere (sympy-12096 never states 16; django-15563 never states 100/101) the only criterion left is
  **weak**: "last value differs from the observed wrong value and nothing raises". It produced 2 valid oracles and 1
  false pass (sympy-22080: formatting drift between the reporter's sympy and `base_commit`). The search must treat a
  weak oracle as a *filter*, not a proof: a candidate that passes it still needs the regression scope and the Jev
  guard.
- **Context chaining** (`chunksWithContext`): a later block's unbound names pull in the earlier blocks that bind them
  (sympy-20428's `bad_poly` from the first transcript, django-15563's models from the bare block, star-import blocks
  when names stay unresolved). Needed on 2 of the 9 valid oracles.
- **Not runnable by a statement runner** (code-detected, `isTestModule`): 3 pytest instances whose reproduction is a
  test file to run under `pytest` (with `--pdb`, `-bb --setup-show`, `caplog`), plus pytest-10356 and the pylint
  instances whose reproduction is `pylint a.py` / a shell command. These need a **command oracle**: write the file,
  run the tool, compare stdout/exit code with the shown output. That is the next module, not this one.

## Design implication

- The design's search gets a goal on **9/30** (30 %) instances: `reproductionGoal()` returns a `FailureView` (`call` =
  the snippet's last statement, e.g. `qs1 | qs2` / `mathematica_code(Max(x,2))`, `expected` = the built text, `actual`
  = the observed value or `ExcType: message`) and a one-test `TestRunSummary` with id `repro::<sha8>` failing, so
  `goals.ts` clusters it like any failing test and `verifyRepro()` re-runs the same script in a candidate lane (a
  gold-patched checkout here; median 552 ms). Of the 9, only two (**django-15315, requests-2931**) are among the nine
  instances §8.3 lists as coverage-reachable; the other seven (sympy-15345, -17139, -19954, -11618, -12096,
  django-15128, -15563) now have a goal but no measured candidate source that reaches their fix. So the oracle widens
  the set of instances the search can *attempt* well beyond the 3–5 predicted solves; it does not by itself make
  their fixes enumerable, and the two overlaps are where a solve is first expected.
- For the remaining **21/30** the honest fallback is the one the brief names: localise (the Q6 file pick is #1 on
  23/30 from the issue text alone, and the traceback anchors above are in the gold file on 3/3), rank candidates with
  Jev, and commit the best-guess patch only under a **regression-only** check: `regressionScope(localizedFiles,
  workspaceFiles, { testCmd })` picks ≤ 6 test files that import or name the localised module (plus the spec's
  `test_cmd` template) so the baseline is "these N files pass" and any candidate that keeps them passing is a
  best-guess commit flagged `possible overfit` in the plan. Split of the 21: 7 have no code at all (feature requests
  and prose-only reports; nothing to reproduce), 5 need a command oracle (pytest/pylint/shell), 4 have snippets that
  cannot run as written (undefined names the library does not export, a Cython toolchain), 1 is a formatting-drift
  false pass on a weak criterion, 1 is a Jev pick error (sympy-20428), 1 is a lint target, 2 are Jev under-calls at
  0.41/0.49 whose snippets would not run anyway.
- Costs are negligible next to the pytest runs the design already budgets: one request ($0.00014 median) and two
  script executions (≈ 1.2 s) per instance; the whole 30-instance pass costs less than one SWE module test run.
- Two cheap follow-ups the numbers justify: (1) a command oracle for test-file and CLI reproductions (5 instances;
  the file, the command and the shown output are all extracted already); (2) let the search prefer `strong` over
  `weak` oracles and require the regression scope before committing on a `weak` one (the sympy-22080 false pass is
  exactly the failure mode).

## Reproduce

```
node node_modules/.bin/tsx experiments/oracle/run.mts --extract-only          # blocks per instance, $0
env -u ANTHROPIC_API_KEY node --env-file=.env node_modules/.bin/tsx experiments/oracle/run.mts   # 23 Jev requests, ≈ $0.003, ≈ 40 s
node node_modules/.bin/tsx experiments/oracle/run.mts --labels                # hand labels instead of Jev, $0
```

Environment used: repos are the existing worktrees `/tmp/jevonly/repos/<instance_id>` (checked clean at
`base_commit` for all 30 before the runs; the gold patch applies with `git apply`, the script re-runs, `git apply -R`
reverts, and the worktree is checked clean again); interpreters are the existing venvs the local evaluator built with
the spec's install commands under `~/.jevcode/runs/bench-work/<run>/<instance>/<condition>/workspace/.venv` (Python
3.9.6; newest per instance whose python imports the package; sympy/django/pylint/pytest editable, requests
non-editable — the `sys.path.insert` puts the checkout first either way). No venv was created for this experiment.
`npx tsc -p tsconfig.json --noEmit` is clean for `src/synth/oracle/**` and `test/unit/synth/oracle/**` (the remaining
errors at the time of writing are in `src/synth/sieve/runner.ts` and `test/unit/synth/search/budget.test.ts`, owned
by another agent); `node scripts/no-any.mjs` ok; `npx vitest run --project unit test/unit/synth/oracle` 69/69.
