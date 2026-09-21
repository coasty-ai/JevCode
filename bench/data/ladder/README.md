# Ladder: hand-made multi-hunk Python repair tasks (`bench/data/ladder/`)

Rung 2 of the difficulty ladder in `docs/JEV-ONLY.md`: twelve small, self-contained Python repair
tasks written by hand for JevCode on **2026-09-20**. QuixBugs (rung 1) is one-line bugs; these tasks
exercise the **long-horizon** behaviour a Jev-only search agent has to get right on top of that:

- several **independent** bugs in one file, each caught by its own failing tests, so the outer loop
  must localise -> fix -> verify one failing test at a time without breaking what already passes;
- fixes that **insert** a line (a `None` guard, an empty-sequence guard, an `import`) rather than
  mutate one;
- a change that must be made **consistently in two files** (a helper's signature and its caller);
- a wrong **constant** inside a config dict, a wrong **attribute** name on a dataclass;
- a **donor-code** case where a whole function body is wrong and a sibling function in the same
  file shows the correct shape.

Everything is pure Python 3.9 standard library, deterministic, offline, and every task's suite runs
in well under a second. `gold/` is the reference fix; the tests are the oracle, so any other edit
that makes the suite pass without touching `tests/` is also a solve.

## Layout

```
bench/data/ladder/
├── README.md              this file
├── index.json             the 20 meta.json objects (12 short, then 8 long), each with an added "path": "tasks/<name>"
├── check.py               verifier: prints the buggy / gold / each-hunk-alone matrix (see below)
└── tasks/<name>/
    ├── task.md            the prompt a user would type
    ├── meta.json          { name, hunks, kinds, files, difficulty, description } (+ tier, expected_failing: long tier)
    ├── pytest.ini         testpaths=tests, pythonpath=., no cache dir (-q in the short tier only, see the long tier)
    ├── src/__init__.py
    ├── src/<module>.py    the buggy code the agent sees (two modules for `table`, 3-6 in the long tier)
    ├── tests/test_<module>.py   4-10 pytest tests (20-60 in the long tier); some fail on src/, all pass on gold/
    └── gold/<module>.py   the fixed module(s); never show these to the agent under test
```

`meta.json` fields: `hunks` is the number of `diff -U0` hunks between `src/` and `gold/` summed over
`files` (`check.py` asserts this); `kinds` are drawn from `operator | off_by_one | guard | import |
attribute | call_args | new_branch | constant | rename | two_files`; `difficulty` is 1-5 as judged
for a search agent with Jev as the only model (1 = one template application with an obvious
locus, 3 = several independent single-line fixes or a keyword argument to add, 4 = multi-line
synthesis or coupled edits across files, 5 = not represented here).

## The tasks

| # | task | hunks | kinds | difficulty | files | failing / total tests | what is wrong |
|---|---|---|---|---|---|---|---|
| 1 | `inventory` | 2 | operator, off_by_one | 2 | `src/inventory.py` | 4 / 10 | `total_value` adds qty and price instead of multiplying; `page()` treats the 1-based page number as 0-based |
| 2 | `textstats` | 2 | call_args, off_by_one | 3 | `src/textstats.py` | 4 / 10 | `most_common` lacks `reverse=True`; `ngrams` range is short by one |
| 3 | `grades` | 2 | operator, rename | 2 | `src/grades.py` | 3 / 10 | `letter_grade` uses `>` for inclusive boundaries; `weighted_average` divides by `len(weights)` not `sum(weights)` |
| 4 | `account` | 3 | operator, off_by_one, rename | 3 | `src/account.py` | 3 / 10 | `withdraw` rejects amount == balance; `statement` numbers from 0; `transfer` calls `dst.withdraw` instead of `dst.deposit` |
| 5 | `calendar_utils` | 3 | operator, off_by_one, call_args | 3 | `src/calendar_utils.py` | 5 / 10 | `is_leap_year` joins clauses with `and`; `day_of_year` has a stray `- 1`; `parse_iso` passes `maxsplit=1` |
| 6 | `profiles` | 1 | guard | 2 | `src/profiles.py` | 2 / 10 | `display_name` calls `.strip()` on a `None` nickname; needs `if user.nickname is None: return user.full_name` |
| 7 | `stats` | 1 | guard | 2 | `src/stats.py` | 2 / 10 | `median([])` raises IndexError; needs `if not values: raise ValueError(...)` like its siblings |
| 8 | `tagcloud` | 1 | import | 1 | `src/tagcloud.py` | 4 / 9 | `collections.Counter` used in three functions, never imported (NameError at call time) |
| 9 | `table` | 3 | two_files, call_args | 4 | `src/fmt.py`, `src/table.py` | 4 / 10 | `fmt.pad` must gain a `fill` parameter (signature + body) and `table.render` must pass `fill` through |
| 10 | `shipping` | 1 | constant | 2 | `src/shipping.py` | 4 / 10 | `CONFIG["free_over"]` is 500.0 instead of 50.0 |
| 11 | `events` | 1 | attribute | 1 | `src/events.py` | 3 / 9 | `agenda_line` reads `event.end_at`; the dataclass field is `ends_at` |
| 12 | `units` | 1 | new_branch, rename | 4 | `src/units.py` | 4 / 10 | the 3-line body of `parse_duration` is wrong; `parse_size` above it is the donor (swap `SIZE_UNITS`/`upper()` for `DURATION_UNITS`/`lower()`) |

Totals: 12 tasks, 13 modules (57-78 lines each), 118 tests, 21 hunks. Distribution as designed:
3 x two independent one-line bugs, 2 x three bugs, 2 x inserted guard, 1 x missing import,
1 x two files changed consistently, 1 x config constant, 1 x wrong attribute, 1 x donor-code body.

### Verification matrix (2026-09-20, `/tmp/ladder-venv`, Python 3.9.6, pytest 8.4.2)

`buggy` and `gold` are tests passing out of total; `each hunk alone` applies one hunk of the gold
diff to the buggy tree and runs the suite, which shows whether the hunks are independent.

```
task            hunks dfclt tests   buggy    gold  each hunk alone (passed/total)     gold s
account             3     3    10    7/10   10/10  h1:8/10 h2:8/10 h3:8/10              0.12
calendar_utils      3     3    10    5/10   10/10  h1:7/10 h2:7/10 h3:6/10              0.12
events              1     1     9     6/9     9/9  -                                    0.12
grades              2     2    10    7/10   10/10  h1:8/10 h2:9/10                      0.12
inventory           2     2    10    6/10   10/10  h1:8/10 h2:8/10                      0.11
profiles            1     2    10    8/10   10/10  -                                    0.11
shipping            1     2    10    6/10   10/10  -                                    0.11
stats               1     2    10    8/10   10/10  -                                    0.11
table               3     4    10    6/10   10/10  h1:6/10 h2:3/10 h3:3/10              0.12
tagcloud            1     1     9     5/9     9/9  -                                    0.11
textstats           2     3    10    6/10   10/10  h1:8/10 h2:8/10                      0.11
units               1     4    10    6/10   10/10  -                                    0.11
```

Reading the "each hunk alone" column: in the five multi-bug tasks every hunk on its own fixes at
least one test and none suffices, i.e. the bugs are independent and the outer loop can take them
in any order. `table` is the deliberate exception: the signature hunk alone (h1) fixes nothing, and
the body hunk (h2) or the caller hunk (h3) alone *breaks* six previously passing tests (NameError
on `fill`, or `pad()` called with three arguments), so a per-hunk verify-and-keep loop cannot reach
the fix one line at a time; it has to propose the helper change as a unit and then the caller.

## The long tier (tasks 13-20, 2026-09-20)

Eight further tasks, `tier: "long"` in their `meta.json`, measure the Jev-only agent's ability to
**chain many verified sub-goals** (docs/JEV-ONLY-DESIGN.md §2.1-§2.3: one goal per failing-test
cluster, one verified sub-goal per step, partials held as a second base) rather than its raw reach.
Every planted bug is a **one-line replace or a one-line insert** that the candidate sources already
enumerate (first-order mutations, the guard/import templates, donor lines, one composite pair), so a
miss measures the horizon, not the vocabulary. The guard insert is the two-line `if x is None:` /
`return default` statement the guard template emits, one contiguous hunk.

The loader (`src/bench/ladder/tasks.ts`) orders records **short tier first, then long**, each in
index order, so `bench --suite ladder --tasks 12` still selects exactly the original twelve in their
original order; the long tasks are positions 13-20 (`--tasks 20`) or `--task-id <name>,...`. Each
long task lists `expected_failing`, the exact failing set of the buggy tree; `check.py` and
`test/unit/bench/ladder-long.test.ts` verify it against a real pytest run. The long-tier `pytest.ini` carries no `-q`:
the jev-only engine runs `python3 -m pytest -q`, and with the ini's own `-q` that is `-qq`, which drops the
counts line; the engine then parses only the last 16 KB of the output, where a 16-failure suite's progress line
no longer is (the `long_chain` first run below never registered its establishing run for exactly this reason).

Every planted line was checked against the code sources with a site probe (`experiments/reach`-style: mutation,
templates, donors, composite at the buggy line, task-text identifiers and test literals as the vocabulary): all 34
are produced by at least one source: 32 by a depth-1 mutation (8 off-by-one literal, 7 relational swap, 5 identifier
substitution, 4 attribute substitution, 2 off-by-one atom, 2 arithmetic swap, keyword flip, drop term, call substitution,
argument swap; five of them also by a template or donor), the `import re` by the import template, the None-guard by the
guard template and a statement donor. The two `crossfile` identifier swaps enter the pool only through the task-text
names (`SYMBOL_KEY`, `CURRENCY_KEY` in task.md). The first live run used an
earlier variant of six of them that the probe showed out of reach (an f-string edit, a `"symbol"` string key, a
keyword-argument name, a `","` literal, an attribute used nowhere else, a comprehension filter); see the rungs log.

| # | task | hunks | modules | failing / total | what it measures | how |
|---|---|---|---|---|---|---|
| 13 | `crossfile` | 4 | fmt, invoice, tax, discount | 8 / 25 | a coordinated pair across two files + 2 independent bugs | `fmt.money` reads its symbol under `CURRENCY_KEY` instead of `SYMBOL_KEY` (module constants of fmt.py; the tests pin `symbol=`) and `invoice.render` builds its options under `CURRENCY_KEY` too. Either identifier swap alone regresses two invoice tests; a definition that reads both keys fails `test_money_ignores_currency_option`; only the pair is green. Plus `tax_for` exempts the threshold (`<=`) and `apply_discount` negates the percentage test (`not in`). |
| 14 | `import_and_guard` | 4 | paths, settings, retry, duration | 12 / 23 | two inserts (import, None-guard) + two replaces | `paths.py` never imports `re` (NameError at call time); `Settings.get` lacks the `if value is None: return default` guard its siblings have; `retry.schedule` has one delay too many; `parse_duration` adds instead of multiplying. |
| 15 | `ledger5` | 5 | isbn, loans, search, shelves | 12 / 30 | pure chain length: five independent goals | ISBN-10 weights 9..1 for 10..2; `is_overdue` `>=`; `fine` `max` for `min`; `rank` `reverse=False`; `label` numbers from 0 (`number = position` drops the `+ 1`). No shared code paths between the bugs. |
| 16 | `long_chain` | 6 | load, clean, enrich, totals, layout, report | 16 / 26 | progress one stage at a time | one exception-raising bug per pipeline stage (`float(kind)` for `float(price)`, `row.label` for `row.name`, `LABELS[row.name]` for `[row.kind]`, `kv[2]` for `kv[1]`, `lines.add` for `.append`, `SEPARATOR` for `SEP`); all 16 pipeline tests start in one goal at `load.parse_row`; each fix moves the remaining failures to the next stage: 16 -> 13 -> 10 -> 6 -> 4 -> 2 -> 0. |
| 17 | `masked` | 3 | report, aggregate, parse (+ levels) | 6 / 22 | re-clustering the same tests twice | all six report tests fail at a NameError in `report.summary`; fixed, two pass and the rest fail in `parse.parse_line` (logs with durations: `int(took[:-1])`) or `aggregate.total_ms` (`e.took`); the callee bugs have no direct tests. |
| 18 | `regress_trap` | 4 | agenda, roster, intervals, names (+ slots) | 7 / 28 | regressions never kept | `Item.span` is off by one; flipping `<` to `<=` in `intervals.contains`/`overlaps` passes the agenda tests but breaks the half-open semantics pinned by `test_intervals`/`test_slots`. Same shape for `roster.badge` vs `names.initials`. Plus two plain bugs (`merge`, `surname`). |
| 19 | `shared_frame` | 2 | booking, pricing (+ checks, schedule) | 6 / 25 | the `account` partial trap | both bugs raise `InvalidValue` at the same line of `checks.ensure_at_least`, so frame clustering merges six tests into one goal; each correct fix alone is a partial with a disjoint newly-passing set. `checks.py`'s own tests pin the helper. |
| 20 | `six_hunks` | 6 | model, filters, sorting, render, stats | 9 / 28 | goals with two complementary partials | three parametrised integration tests in one shared file, each with cases `a_only` / `b_only` / `both` over a pair of data-dependent bugs; the per-module tests cover only the unaffected inputs. |

Totals for the tier: 8 tasks, 36 modules, 207 tests, 34 hunks; 76 tests fail on the buggy trees.
The numbering is the selection order (alphabetical within the tier), not the design order.

### Long-tier verification (2026-09-20, `~/.jevcode/runs/ladder-venv`, Python 3.9.6, pytest 8.4.2)

`python3 bench/data/ladder/check.py --python ~/.jevcode/runs/ladder-venv/bin/python` prints the
matrix for all 20 (each hunk alone, buggy, gold, `expected_failing` agreement). Designed behaviours
checked by hand with single-fix and cumulative-fix trees:

- `masked`: fix A alone -> `test_summary_empty`, `test_render_empty` pass; `test_summary_counts_levels`,
  `test_summary_plain_lines_have_no_duration` move to `aggregate.py:<genexpr>`, `test_summary_total_and_slowest`,
  `test_render_full` to `parse.py:parse_line`; fix C after A moves those two to aggregate as well.
- `shared_frame`: h1 alone 21/25, h2 alone 23/25 (each the other's tests still failing at the same
  helper line); relaxing the helper's `<` breaks `test_checks` and `test_booking` instead.
- `crossfile`: the definition hunk alone 18/25 with two invoice regressions, the call-site hunk alone
  15/25 with the same two regressions; the pair 20/25 with none; the run-1b sidestep (a second
  `options.get(SYMBOL_KEY, symbol)` line reading both keys) fails the pinning test.
- `regress_trap`: `contains` `<`->`<=` passes two agenda tests and breaks two pinned tests;
  `overlaps` `<`->`<=` passes the clash test and breaks two more; shortening `initials` passes both
  badge tests and breaks `test_initials`.
- `six_hunks`: each fix alone passes exactly its `*_only` case; a pair closes its test function.
- `long_chain`: cumulative fixes 16 -> 13 -> 10 -> 6 -> 4 -> 2 -> 0 failing, the remaining failures'
  innermost frame moving load -> clean -> enrich -> totals -> layout -> report.

## Running one task by hand

```sh
cp -r bench/data/ladder/tasks/account /tmp/account && cd /tmp/account
python3 -m venv .venv && .venv/bin/pip -q install pytest
.venv/bin/python -m pytest              # 3 failed, 7 passed
cat task.md                             # the prompt; edit src/account.py until the suite is green
diff -u src/account.py gold/account.py  # the reference fix
cp gold/account.py src/ && .venv/bin/python -m pytest   # 10 passed
```

Point an agent at the copied directory with the text of `task.md`; grade by running
`python -m pytest -q` in that directory and requiring exit status 0 with `tests/` unchanged
(`git diff --quiet -- tests/` after `git init && git add -A && git commit -qm init` on the copy).

## Re-verifying the whole ladder

```sh
python3 -m venv /tmp/ladder-venv && /tmp/ladder-venv/bin/pip -q install pytest
python3 bench/data/ladder/check.py --python /tmp/ladder-venv/bin/python        # all 20
python3 bench/data/ladder/check.py --python /tmp/ladder-venv/bin/python table   # one task
```

`check.py` copies each task to a temporary directory (the checked-in tree is never written to),
runs buggy, each-hunk-alone and gold, and exits 1 if any gold fails, any buggy passes every test,
any buggy passes no test (no pass-to-pass regression guard), a suite is outside its tier's size
(short: 4-10 tests, gold under 2 s; long: 20-60 tests, gold under 3 s), `expected_failing` (required
for the long tier) differs from the buggy run's failing set, `meta.hunks` disagrees with `diff -U0`,
a gold file differs from `src/` without being listed in `meta.files`, or `index.json` disagrees with
the `meta.json` files or is not ordered short tier (by name) then long tier (by name).

## Licence

MIT. Copyright (c) 2026 the JevCode authors. Written by hand on 2026-09-20 for JevCode; no code
or text here is copied from any other benchmark or project.

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
associated documentation files (the "Software"), to deal in the Software without restriction,
including without limitation the rights to use, copy, modify, merge, publish, distribute,
sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions: the above copyright notice and this
permission notice shall be included in all copies or substantial portions of the Software.
THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
