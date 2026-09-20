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
├── index.json             the 12 meta.json objects, each with an added "path": "tasks/<name>"
├── check.py               verifier: prints the buggy / gold / each-hunk-alone matrix (see below)
└── tasks/<name>/
    ├── task.md            the prompt a user would type
    ├── meta.json          { name, hunks, kinds, files, difficulty, description }
    ├── pytest.ini         testpaths=tests, pythonpath=., -q, no cache dir
    ├── src/__init__.py
    ├── src/<module>.py    the buggy code the agent sees (two modules for `table`)
    ├── tests/test_<module>.py   4-10 pytest tests; some fail on src/, all pass on gold/
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
python3 bench/data/ladder/check.py --python /tmp/ladder-venv/bin/python        # all 12
python3 bench/data/ladder/check.py --python /tmp/ladder-venv/bin/python table   # one task
```

`check.py` copies each task to a temporary directory (the checked-in tree is never written to),
runs buggy, each-hunk-alone and gold, and exits 1 if any gold fails, any buggy passes every test,
any buggy passes no test (no pass-to-pass regression guard), a suite has fewer than 4 or more than
10 tests or takes over 2 s, `meta.hunks` disagrees with `diff -U0`, a gold file differs from `src/`
without being listed in `meta.files`, or `index.json` disagrees with the `meta.json` files.

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
