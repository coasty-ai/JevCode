# QuixBugs (Python) for the Jev-only program-repair experiment

Checked-in, self-contained copy of the 40 Python programs of the **QuixBugs** benchmark, each in its buggy and its correct form, with their test cases and a stdlib-only test runner. Nothing here needs Docker, pip or network.

| | |
|---|---|
| Source | https://github.com/jkoppel/QuixBugs |
| Commit | `4257f44b0ff1181dedaedee6a447e133219fcebf` (`git -C /tmp/quixbugs rev-parse HEAD` of a shallow clone of `master`) |
| Fetched | 2026-09-20 |
| Licence | MIT, Copyright 2017-2019 James Koppel (full text at the end of this file; `license: "MIT"` on every `index.json` record) |
| Upstream dirs used | `python_programs/`, `correct_python_programs/`, `json_testcases/`, `python_testcases/`, `tester.py` |

## Layout

| Path | Count | Contents |
|---|---|---|
| `programs/<name>.py` | 40 | buggy program, upstream `python_programs/<name>.py` minus the trailing docstring block (rule below) |
| `programs/node.py` | 1 | upstream `python_programs/node.py` verbatim (helper class for the graph programs; identical to `correct_python_programs/node.py`) |
| `correct/<name>.py` | 40 | reference fix, upstream `correct_python_programs/<name>.py`, same stripping |
| `correct/node.py` | 1 | same file as `programs/node.py` |
| `tests/<name>.json` | 31 | JSON array of `{"input": [...], "expected": ...}` converted from `json_testcases/<name>.json` (242 cases) |
| `tests/<name>_test.py` | 9 | assert-based pytest modules for the graph programs, from `python_testcases/test_<name>.py` with the import header adapted (36 tests) |
| `index.json` | 1 | one record per program (schema below) |
| `run_tests.py` | 1 | runner: `python3 run_tests.py <name> <candidate.py>` prints one JSON line, exits 0/1 |

Programs whose tests are pytest modules rather than JSON cases (the 9 graph/linked-list programs, exactly QuixBugs' `graph_based` list in `tester.py`): `breadth_first_search`, `depth_first_search`, `detect_cycle`, `minimum_spanning_tree`, `reverse_linked_list`, `shortest_path_length`, `shortest_path_lengths`, `shortest_paths`, `topological_ordering`.

## Conversion rules

**Stripping rule (programs/ and correct/).** Upstream appends a module-level docstring after the code of every `python_programs/<name>.py`: a line that is exactly `"""` at column 0, free text (description, Input/Precondition/Output/Example), and a closing line that is exactly `"""`, followed only by blank lines. That block and the blank lines immediately before it are removed; every remaining line is byte-identical to upstream and the file ends with exactly one newline. No program contains any other triple-quoted string, so the block is always the second-to-last and last `"""` lines of the file (asserted during the build). 19 of the 40 `correct_python_programs` carry the same block and were stripped identically; the other 21 have none and only had trailing blank lines normalised. Leading blank lines were kept (several correct files start with one), so a line number in `correct/` can be one higher than in `programs/`; `bugLine` always refers to `programs/<name>.py`.

**JSON conversion rule (tests/<name>.json).** Upstream `json_testcases/<name>.json` is JSON-lines, one `[[arg1, arg2, ...], expected]` per line. Each line becomes the object `{"input": [arg1, arg2, ...], "expected": expected}`; the file is a real JSON array with one object per line. Values are re-serialised by Python's `json` module, which round-trips every upstream number exactly (floats such as `1.4166666666666665` and `4.0` are preserved as floats). `tester.py` wraps a non-list `input` in a list; no upstream case needed that. Two optional keys were added, both honoured by `run_tests.py`:

- `"slow": true` on the two cases the official `python_testcases` suite skips by default: `knapsack` capacity 6404180 with 24 items (`pytest.skip("Takes about 4 mins to pass!")`) and `levenshtein("amanaplanacanalpanama", "docnoteidissentafastneverpreventsafatnessidietoncod")` (`pytest.skip("Takes too long to pass!")`). Skipped unless `--slow`; both time out at 2 s even on the correct programs.
- `"timeout": 10` on `levenshtein("rosettacode", "raisethysword")`: the correct (exponential) program needs about 1.1 s single-core on an Apple-silicon Mac and exceeded the 2 s default under CPU contention during verification. The runner uses `max(--timeout, case.timeout)`. Delete the key to get a strict 2 s everywhere.

**Test-module rule (tests/<name>_test.py).** Upstream has two kinds of test file for the graph programs: `python_programs/<name>_test.py` is a print-only driver (no assertions, no oracle; `tester.py` just runs it for a human to read), while `python_testcases/test_<name>.py` is the assert-based pytest module. The pytest module is what is checked in. Its header

```python
import pytest
from node import Node            # only in the modules that use Node

if pytest.use_correct:
    from correct_python_programs.<name> import <name>
else:
    from python_programs.<name> import <name>
```

was replaced by `from node import Node` (where present) and `from <name> import <name>`; everything below the header is byte-identical. The modules therefore import the program under test from `sys.path` and no longer need pytest or QuixBugs' `conftest.py`, but they are still valid pytest files (`*_test.py`, `test*` functions).

## `index.json`

Array of 40 records, sorted by name:

| key | type | meaning |
|---|---|---|
| `name` | string | program and function name (`programs/<name>.py` defines `def <name>(...)`) |
| `bugLine` | int | 1-based line in `programs/<name>.py` that differs from `correct/<name>.py`. For the four insertion fixes (`depth_first_search`, `reverse_linked_list`, `shunting_yard`, `wrap`) it is the line *before which* the missing statement belongs. |
| `buggyLine` | string or null | text of that line, whitespace-stripped; `null` for the four insertion fixes |
| `fixedLine` | string | text of the corresponding line in `correct/<name>.py`, whitespace-stripped |
| `kind` | string | one of `operator`, `off_by_one`, `argument_swap`, `missing_condition`, `wrong_variable`, `wrong_call`, `control_flow`, `other` (rule below) |
| `hasJsonTests` | bool | `true`: `tests/<name>.json`; `false`: `tests/<name>_test.py` |
| `testCount` | int | JSON cases (including the `slow` ones) or `test*` functions |
| `license` | string | `"MIT"` |

**How `bugLine` was computed.** Both files were tokenised with the stdlib `tokenize` module, `COMMENT` tokens removed, blank lines dropped and the remaining lines compared whitespace-stripped with `difflib.SequenceMatcher` (`autojunk=False`). Every program yields exactly one non-equal hunk, of one line on each side (replace) or one inserted line (the four insertions). Comment removal matters for two programs: `possible_change` has a `# Python 3` first line only in the buggy file and `powerset` has a trailing `#python3 just like car and cdr ...` comment only in the buggy file; neither is the bug.

**How `kind` was assigned** (by hand, comparing `buggyLine` and `fixedLine`; every program is a single-line fix):

| kind | n | rule and members |
|---|---|---|
| `other` | 9 | `depth_first_search`, `get_factors`, `kth`, `powerset`, `reverse_linked_list`, `shunting_yard`, `sqrt`, `subsequences`, `wrap` |
| `off_by_one` | 8 | `find_first_in_sorted`, `find_in_sorted`, `knapsack`, `lcs_length`, `levenshtein`, `mergesort`, `next_palindrome`, `pascal` |
| `wrong_variable` | 7 | `bucketsort`, `hanoi`, `kheapsort`, `longest_common_subsequence`, `shortest_path_length`, `shortest_paths`, `topological_ordering` |
| `missing_condition` | 5 | `detect_cycle`, `is_valid_parenthesization`, `lis`, `max_sublist_sum`, `possible_change` |
| `argument_swap` | 5 | `gcd`, `next_permutation`, `rpn_eval`, `shortest_path_lengths`, `to_base` |
| `wrong_call` | 3 | `flatten`, `minimum_spanning_tree`, `sieve` |
| `operator` | 2 | `bitcount`, `quicksort` |
| `control_flow` | 1 | `breadth_first_search` |

- `operator`: an arithmetic/bitwise/comparison operator token is wrong and the fix is not a boundary shift (`^=`→`&=`, `>`→`>=` on a partition predicate).
- `off_by_one`: a boundary or index is off by one: `<=`/`<` on a loop bound, `mid`→`mid + 1`, `r`→`r + 1`, `j`→`j - 1`, `len(...)`→`len(...) - 1`, base case `== 0`→`<= 1`, a spurious `1 +`, `<`→`<=` on a capacity check.
- `argument_swap`: the same two operands or arguments appear in the wrong order (function arguments, comparison operands, tuple indices, string concatenation order).
- `missing_condition`: a guard or clause is missing, or a constant stands where a condition belongs (`return True`→`return depth == 0`, missing `or not coins`, missing `hare is None or`, missing `max(...)` clamp).
- `wrong_variable`: the wrong variable, attribute, slice or collection is referenced in an otherwise correct expression.
- `wrong_call`: the wrong function is called or a call is spurious (`any`→`all`, `yield flatten(x)`→`yield x`, `.update()` where an assignment belongs).
- `control_flow`: the loop structure itself is wrong (`while True:`→`while queue:`).
- `other`: a whole statement is missing (`depth_first_search`, `reverse_linked_list`, `shunting_yard`, `wrap`), a returned constant is wrong (`get_factors`, `subsequences`), or a term of an expression is missing (`kth`, `powerset`, `sqrt`).

## The 40 programs

Results are from the verification run described in the next section (`run_tests.py` with defaults on `programs/<name>.py` and `correct/<name>.py`; Python 3.9.6, macOS, 2026-09-20). `a/b` = passed/total; "error" = exception (mostly `RecursionError`, `IndexError`, `AttributeError`, `RuntimeError`), "timeout" = killed after 2 s.

| # | program | kind | bugLine | buggy line | fixed line | tests | buggy result | correct result |
|---|---|---|---|---|---|---|---|---|
| 1 | `bitcount` | operator | 5 | `n ^= n - 1` | `n &= n - 1` | 9 json | 0/9 (9 timeout) | 9/9 |
| 2 | `breadth_first_search` | control_flow | 11 | `while True:` | `while queue:` | 5 pytest | 4/5 (1 error) | 5/5 |
| 3 | `bucketsort` | wrong_variable | 7 | `for i, count in enumerate(arr):` | `for i, count in enumerate(counts):` | 7 json | 1/7 (6 fail) | 7/7 |
| 4 | `depth_first_search` | other | 10 |  | `nodesvisited.add(node)` | 5 pytest | 4/5 (1 error) | 5/5 |
| 5 | `detect_cycle` | missing_condition | 5 | `if hare.successor is None:` | `if hare is None or hare.successor is None:` | 6 pytest | 5/6 (1 error) | 6/6 |
| 6 | `find_first_in_sorted` | off_by_one | 5 | `while lo <= hi:` | `while lo < hi:` | 7 json | 4/7 (1 error, 2 timeout) | 7/7 |
| 7 | `find_in_sorted` | off_by_one | 9 | `return binsearch(mid, end)` | `return binsearch(mid + 1, end)` | 7 json | 5/7 (2 error) | 7/7 |
| 8 | `flatten` | wrong_call | 7 | `yield flatten(x)` | `yield x` | 7 json | 1/7 (6 fail) | 7/7 |
| 9 | `gcd` | argument_swap | 5 | `return gcd(a % b, b)` | `return gcd(b, a % b)` | 6 json | 1/6 (5 error) | 6/6 |
| 10 | `get_factors` | other | 10 | `return []` | `return [n]` | 11 json | 1/11 (10 fail) | 11/11 |
| 11 | `hanoi` | wrong_variable | 6 | `steps.append((start, helper))` | `steps.append((start, end))` | 8 json | 1/8 (7 fail) | 8/8 |
| 12 | `is_valid_parenthesization` | missing_condition | 12 | `return True` | `return depth == 0` | 3 json | 2/3 (1 fail) | 3/3 |
| 13 | `kheapsort` | wrong_variable | 7 | `for x in arr:` | `for x in arr[k:]:` | 4 json | 1/4 (3 fail) | 4/4 |
| 14 | `knapsack` | off_by_one | 12 | `if weight < j:` | `if weight <= j:` | 10 json | 3/10 (6 fail, 1 skipped) | 9/10 (1 skipped) |
| 15 | `kth` | other | 12 | `return kth(above, k)` | `return kth(above, k - num_lessoreq)` | 7 json | 3/7 (4 error) | 7/7 |
| 16 | `lcs_length` | off_by_one | 9 | `dp[i, j] = dp[i - 1, j] + 1` | `dp[i, j] = dp[i - 1, j - 1] + 1` | 9 json | 1/9 (8 fail) | 9/9 |
| 17 | `levenshtein` | off_by_one | 6 | `return 1 + levenshtein(source[1:], target[1:])` | `return levenshtein(source[1:], target[1:])` | 7 json | 1/7 (5 fail, 1 skipped) | 6/7 (1 skipped) |
| 18 | `lis` | missing_condition | 14 | `longest = length + 1` | `longest = max(longest, length + 1)` | 12 json | 8/12 (4 fail) | 12/12 |
| 19 | `longest_common_subsequence` | wrong_variable | 6 | `return a[0] + longest_common_subsequence(a[1:], b)` | `return a[0] + longest_common_subsequence(a[1:], b[1:])` | 10 json | 6/10 (4 fail) | 10/10 |
| 20 | `max_sublist_sum` | missing_condition | 7 | `max_ending_here = max_ending_here + x` | `max_ending_here = max(0, max_ending_here + x)` | 6 json | 2/6 (4 fail) | 6/6 |
| 21 | `mergesort` | off_by_one | 17 | `if len(arr) == 0:` | `if len(arr) <= 1:` | 14 json | 1/14 (13 error) | 14/14 |
| 22 | `minimum_spanning_tree` | wrong_call | 12 | `group_by_node[node].update(group_by_node[u])` | `group_by_node[node] = group_by_node[u]` | 3 pytest | 0/3 (3 error) | 3/3 |
| 23 | `next_palindrome` | off_by_one | 15 | `return [1] + (len(digit_list)) * [0] + [1]` | `return [1] + (len(digit_list) - 1) * [0] + [1]` | 5 json | 4/5 (1 fail) | 5/5 |
| 24 | `next_permutation` | argument_swap | 6 | `if perm[j] < perm[i]:` | `if perm[i] < perm[j]:` | 8 json | 0/8 (8 fail) | 8/8 |
| 25 | `pascal` | off_by_one | 6 | `for c in range(0, r):` | `for c in range(0, r + 1):` | 5 json | 1/5 (1 fail, 3 error) | 5/5 |
| 26 | `possible_change` | missing_condition | 5 | `if total < 0:` | `if total < 0 or not coins:` | 10 json | 1/10 (9 error) | 10/10 |
| 27 | `powerset` | other | 6 | `return [[first] + subset for subset in rest_subsets]` | `return rest_subsets + [[first] + subset for subset in rest_subsets]` | 5 json | 1/5 (4 fail) | 5/5 |
| 28 | `quicksort` | operator | 7 | `greater = quicksort([x for x in arr[1:] if x > pivot])` | `greater = quicksort([x for x in arr[1:] if x >= pivot])` | 13 json | 12/13 (1 fail) | 13/13 |
| 29 | `reverse_linked_list` | other | 6 |  | `prevnode = node` | 3 pytest | 1/3 (2 fail) | 3/3 |
| 30 | `rpn_eval` | argument_swap | 20 | `op(token, a, b)` | `op(token, b, a)` | 6 json | 3/6 (3 fail) | 6/6 |
| 31 | `shortest_path_length` | wrong_variable | 22 | `get(unvisited_nodes, nextnode) + length_by_edge[node, nextnode]` | `distance + length_by_edge[node, nextnode]` | 4 pytest | 2/4 (2 fail) | 4/4 |
| 32 | `shortest_path_lengths` | argument_swap | 13 | `length_by_path[i, k] + length_by_path[j, k]` | `length_by_path[i, k] + length_by_path[k, j]` | 4 pytest | 0/4 (4 fail) | 4/4 |
| 33 | `shortest_paths` | wrong_variable | 10 | `weight_by_edge[u, v] = min(` | `weight_by_node[v] = min(` | 3 pytest | 0/3 (3 fail) | 3/3 |
| 34 | `shunting_yard` | other | 19 |  | `opstack.append(token)` | 6 json | 2/6 (4 fail) | 6/6 |
| 35 | `sieve` | wrong_call | 4 | `if any(n % p > 0 for p in primes):` | `if all(n % p > 0 for p in primes):` | 6 json | 1/6 (5 fail) | 6/6 |
| 36 | `sqrt` | other | 4 | `while abs(x - approx) > epsilon:` | `while abs(x - approx ** 2) > epsilon:` | 7 json | 1/7 (6 timeout) | 7/7 |
| 37 | `subsequences` | other | 3 | `return []` | `return [[]]` | 12 json | 2/12 (10 fail) | 12/12 |
| 38 | `to_base` | argument_swap | 9 | `result = result + alphabet[i]` | `result = alphabet[i] + result` | 10 json | 3/10 (7 fail) | 10/10 |
| 39 | `topological_ordering` | wrong_variable | 6 | `if set(ordered_nodes).issuperset(nextnode.outgoing_nodes) and nextnode not in ordered_nodes:` | `if set(ordered_nodes).issuperset(nextnode.incoming_nodes) and nextnode not in ordered_nodes:` | 3 pytest | 0/3 (3 fail) | 3/3 |
| 40 | `wrap` | other | 10 |  | `lines.append(text)` | 5 json | 0/5 (5 fail) | 5/5 |

Totals over the 40 buggy programs: 278 tests, 89 passed, 127 failed, 60 errors of which 17 timeouts, 2 skipped; every buggy program exits 1. Over the 40 correct programs: 278 tests, 276 passed, 0 failed, 0 errors, 2 skipped (the two `slow` cases); every correct program exits 0. Wall time for the whole 40x2 matrix, three programs at a time: about 7 s.

## Evaluating a candidate program

### `run_tests.py` (recommended; Python 3.9+, stdlib only)

```
python3 bench/data/quixbugs/run_tests.py <name> <path-to-candidate.py> [--timeout 2] [--slow] [--max-failures 5] [--jobs N]
```

The candidate can live anywhere and have any file name; it is loaded with `importlib` under the module name `<name>` and must define `<name>`. One JSON line is printed on stdout:

```json
{"name": "gcd", "passed": 1, "failed": 0, "errors": 5, "timeouts": 0, "skipped": 0, "total": 6,
 "failures": [{"input": [13, 13], "expected": 13, "actual": "RecursionError: maximum recursion depth exceeded in comparison"}, "..."]}
```

`passed + failed + errors + skipped == total`; `errors` counts exceptions *and* timeouts, `timeouts` is the timeout subset; `failures` lists the first `--max-failures` (5) non-passing tests, with `actual` = `repr(result)` for a wrong answer, `ExceptionType: message` for an exception (module tests add `(at <file>:<line>: <source>)`), or `TIMEOUT after 2s`. For module tests `input` is the test function name plus the first line of its docstring and `expected` is `"pass"`. Exit status 0 iff `failed == 0 and errors == 0 and total > 0`; 1 otherwise; 2 for a missing candidate or unknown name (with `{"name", "error"}` on stdout).

*JSON programs.* Each case runs in its own subprocess (`--jobs` at a time, default `min(8, cpus)`), so an infinite loop or runaway allocation is killed after `--timeout` seconds without affecting other cases. Inside the child: `actual = <name>(*copy.deepcopy(input))`; if `actual` is a generator it is materialised with `list()`; then `actual == expected`, except `sqrt`: `abs(actual - expected) <= epsilon` with `epsilon = input[-1]`, and `hanoi`: `expected` is compared as `[tuple(x) for x in expected]`. Anything the candidate prints goes to stderr and cannot corrupt the result. Cases with `"slow": true` are skipped unless `--slow`.

*pytest-style programs.* The module `tests/<name>_test.py` is executed once in a child process with `programs/` on `sys.path` (for `node`) and the candidate pre-registered as `sys.modules["<name>"]`; its `test*` functions are called in definition order, each under a `SIGALRM` timeout of `--timeout` seconds, and the child as a whole is killed after `timeout * (n + 1) + 5` seconds (tests still unreported are then counted as timeouts). Running them in order inside one process is required: `detect_cycle_test.py` mutates module-level nodes across tests (`test6` relies on `test3` having set `node1.successor = node2`), exactly as under pytest.

### What the official QuixBugs harness does, and what is mirrored

- `tester.py <name>` has **no oracle**. For JSON programs it loads each JSON line, deep-copies the input, calls the correct and the buggy Python (and Java) versions with `*input`, and prints both results for a human; a generator result is printed as `(generator) [..]` via `list()`. For the nine graph programs it runs the print-only `<name>_test.py` drivers. Exceptions are printed as `sys.exc_info()` tuples.
- `python_testcases/test_<name>.py` (run with `pytest [--correct] [--runslow]` from the repo root) is the automated oracle and is what `run_tests.py` mirrors: `assert <name>(*input_data) == expected` for 27 programs; `list(flatten(...))` and `list(kheapsort(...))` for the two generators; `pytest.approx(expected, abs=input_data[-1])` for `sqrt` (absolute tolerance only, equal to the `epsilon` argument); `[tuple(x) for x in out]` on the expected values for `hanoi`; `pytest.skip` on the two slow cases above; the graph tests are the modules checked in here.
- Not mirrored: nothing else. The runner is strict `==` elsewhere, so a candidate that returns tuples where a list is expected (other than `hanoi`), or a set for `powerset`, fails just as it does upstream. Note that `rpn_eval` expectations are floats (`4.0`) and its programs return floats; `True == 1` holds in Python for `bitcount`-style results as upstream.

### Running with pytest instead

pytest is not vendored and was not available on the verification machine, so this path is documented but unverified here. For a graph program:

```
cd bench/data/quixbugs
PYTHONPATH=programs python3 -m pytest -q tests/breadth_first_search_test.py          # buggy
PYTHONPATH=correct  python3 -m pytest -q tests/breadth_first_search_test.py          # reference
PYTHONPATH=/dir/containing/<name>.py:programs python3 -m pytest -q tests/<name>_test.py   # candidate, must be named <name>.py
```

`programs/` (or `correct/`) is needed for `node.py` even when the candidate lives elsewhere. Note that pytest has no per-test timeout by default, so a hanging candidate hangs the run; use `run_tests.py`, or `pytest-timeout`, for anything untrusted. For JSON programs there is no pytest wrapper here; a one-liner equivalent of the runner's child is

```
PYTHONPATH=programs python3 -c 'import json,copy,types; from gcd import gcd
for c in json.load(open("tests/gcd.json")):
    r = gcd(*copy.deepcopy(c["input"])); r = list(r) if isinstance(r, types.GeneratorType) else r
    print("PASS" if r == c["expected"] else "FAIL %r -> %r != %r" % (c["input"], r, c["expected"]))'
```

(with the `sqrt`/`hanoi` special cases added if used on those two).

## Known quirks

- **Hanging bugs.** The buggy `bitcount` (all 9 cases), `sqrt` (6 of 7) and `find_first_in_sorted` (2 of 7) loop forever; that is the 17 timeouts in the table. `gcd`, `mergesort`, `depth_first_search`, `find_in_sorted`, `kth` and `possible_change` recurse without bound (`RecursionError`, reported as errors, fast). Any runner must enforce a timeout; 2 s is ample for every correct program except the annotated `levenshtein` case.
- **Correct programs that do not pass their own tests within 2 s.** Only `levenshtein`: the reference implementation is exponential. `levenshtein("amanaplanacanalpanama", "docnoteidissentafastneverpreventsafatnessidietoncod")` is skipped upstream and here (`slow`); `levenshtein("rosettacode", "raisethysword")` is run upstream, takes ~1.1 s here and carries `"timeout": 10`. `knapsack`'s 24-item case is the other upstream skip (memoised DP over capacity 6404180, minutes). With the two `slow` skips and the one override, all 40 correct programs pass (verified above); without the override, `levenshtein` is flaky under CPU load.
- **Shared test state.** `tests/detect_cycle_test.py` builds its linked list at module level and `test2`, `test3`, `test6` mutate it; the tests are order-dependent and must run in one process, in file order.
- **`node.py`** uses mutable default arguments (`successors=[]`, ...) and defines methods (`successor()`, `successors()`, `predecessors()`) that are shadowed by the instance attributes of the same name. The tests always pass explicit lists and only use the attributes, and no program calls the methods; kept verbatim.
- **Skipped cases count towards `total`.** `knapsack` and `levenshtein` report `total` 10 and 7 but at most 9 and 6 can pass without `--slow`; the exit status ignores skipped tests.
- **Line-number offsets.** Several `correct/` files start with a blank line that the buggy file lacks (e.g. `gcd`, `bucketsort`), so do not compare line numbers across the two directories; use `bugLine` on `programs/` and match `fixedLine` by text.
- **Buggy `possible_change`** starts with a `# Python 3` comment (line 1), so its code begins on line 2; the bug is on line 5 in both numberings.

## Licence

`programs/`, `correct/`, `tests/` and the test data are derived from QuixBugs and are redistributed under its licence, reproduced verbatim from `LICENSE` at the pinned commit:

```
Copyright 2017-2019 James Koppel

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

`run_tests.py`, `index.json` and this README are JevCode files; the `kind` labels and `bugLine` values are our annotations.
