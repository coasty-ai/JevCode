| instance | blocks (kinds) | Jev pick (p) / label | kind (p) / label | criterion | base | gold | outcome | Jev $ / ms | wall s |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| sympy__sympy-12096 | 1 (repl) | 0 (0.94) / [0] | wrong_value (0.85) / wrong_value | differs_from_actual (weak) | fail: f(g(2)) | PASS | **valid_weak** | $0.0001 / 200.035709 ms | 0.9 |
| sympy__sympy-15345 | 1 (code) | 0 (0.72) / [0] | wrong_value (1.00) / wrong_value | values | fail: 'Max(2, x)' | PASS | **valid** | $0.0001 / 136.99699999999984 ms | 3.1 |
| sympy__sympy-17139 | 1 (repl) | 0 (0.89) / [0] | exception_raised (1.00) / exception_raised | no_exception | fail: TypeError: Invalid comparison of complex | PASS | **valid** | $0.0003 / 283.37445900000057 ms | 6.6 |
| sympy__sympy-19954 | 3 (code, traceback, code) | 0 (0.92) / [0,2] | exception_raised (1.00) / exception_raised | no_exception | fail: IndexError: list assignment index out of | PASS | **valid** | $0.0002 / 200.97033300000112 ms | 3.5 |
| sympy__sympy-11618 | 1 (repl) | 0 (0.74) / [0] | wrong_value (1.00) / wrong_value | values | fail: 1 | PASS | **valid** | $0.0001 / 208.2435000000005 ms | 2.0 |
| sympy__sympy-13798 | 2 (repl, repl) | none / [] | none_of_these (0.91) / none_of_these | - | - | - | **no_pick** | $0.0001 / 186.39300000000003 ms | 0.2 |
| sympy__sympy-16792 | 4 (code, code, output, code) | 0 (0.94) / [0] | exception_raised (0.95) / exception_raised | no_exception | fail: CodeWrapError: Error while executing com | fail: CodeWrapError: Error while executing com | **fails_on_gold** | $0.0002 / 127.90570799999841 ms | 2.6 |
| sympy__sympy-20428 | 7 (repl, repl, repl, repl, repl, repl, repl) | 0 (0.86) / [1,2,5] | wrong_value (0.54) / wrong_value | values | fail: Poly(0, x, domain='EX') | fail: Poly(0, x, domain='EX') | **fails_on_gold** | $0.0005 / 298.6959160000006 ms | 11.7 |
| sympy__sympy-22080 | 1 (repl) | 0 (0.86) / [0] | wrong_value (1.00) / wrong_value | differs_from_actual (weak) | pass | - | **passes_on_base** | $0.0001 / 254.60762500000055 ms | 1.5 |
| sympy__sympy-12489 | 0 () | - / [] | - / none_of_these | - | - | - | **no_blocks** | - | 0.0 |
| django__django-14787 | 1 (code) | none / [0] | exception_raised (1.00) / exception_raised | - | - | - | **no_pick** | $0.0001 / 169.77383399999962 ms | 0.2 |
| django__django-15315 | 1 (code) | 0 (0.86) / [0] | exception_raised (1.00) / exception_raised | no_exception | fail: AssertionError:  | PASS | **valid** | $0.0001 / 235.6049579999999 ms | 1.2 |
| django__django-15572 | 0 () | - / [] | - / wrong_value | - | - | - | **no_blocks** | - | 0.0 |
| django__django-16100 | 0 () | - / [] | - / none_of_these | - | - | - | **no_blocks** | - | 0.0 |
| django__django-14725 | 0 () | - / [] | - / none_of_these | - | - | - | **no_blocks** | - | 0.0 |
| django__django-15103 | 0 () | - / [] | - / none_of_these | - | - | - | **no_blocks** | - | 0.0 |
| django__django-15375 | 2 (repl, repl) | 1 (0.81) / [1] | exception_raised (1.00) / exception_raised | no_exception | fail: NameError: name 'Book' is not defined | fail: NameError: name 'Book' is not defined | **fails_on_gold** | $0.0001 / 151.8706250000032 ms | 1.1 |
| django__django-15563 | 2 (code, repl) | 1 (0.70) / [1] | wrong_value (0.97) / wrong_value | differs_from_actual (weak) | fail: <QuerySet [{'field_otherbase': 55}, {'fi | PASS | **valid_weak** | $0.0001 / 190.5210420000003 ms | 1.5 |
| django__django-15916 | 1 (code) | none / [0] | wrong_value (0.87) / wrong_value | - | - | - | **no_pick** | $0.0001 / 196.0792500000025 ms | 0.2 |
| django__django-15128 | 1 (code) | 0 (0.75) / [0] | exception_raised (1.00) / exception_raised | no_exception | fail: AssertionError:  | PASS | **valid** | $0.0001 / 864.7775420000035 ms | 1.9 |
| pytest-dev__pytest-10081 | 5 (code, output, output, traceback, output) | none / [0] | exception_raised (1.00) / none_of_these | - | - | - | **not_runnable** | $0.0002 / 188.77137499999662 ms | 0.2 |
| pytest-dev__pytest-7205 | 2 (code, traceback) | none / [0] | exception_raised (1.00) / exception_raised | - | - | - | **not_runnable** | $0.0004 / 195.94983299999876 ms | 0.2 |
| pytest-dev__pytest-10051 | 2 (code, output) | none / [0] | exception_raised (0.94) / exception_raised | - | - | - | **not_runnable** | $0.0001 / 214.85383299999376 ms | 0.2 |
| pytest-dev__pytest-7324 | 1 (repl) | 0 (0.64) / [0] | exception_raised (0.91) / exception_raised | no_exception | fail: NameError: name 'Expression' is not defi | fail: NameError: name 'Expression' is not defi | **fails_on_gold** | $0.0001 / 191.8135409999959 ms | 0.5 |
| pytest-dev__pytest-10356 | 2 (code, code) | none / [0,1] | wrong_value (0.91) / wrong_value | - | - | - | **no_pick** | $0.0002 / 192.799500000001 ms | 0.2 |
| pylint-dev__pylint-4970 | 0 () | - / [] | - / wrong_value | - | - | - | **no_blocks** | - | 0.0 |
| pylint-dev__pylint-4604 | 3 (code, output, output) | 0 (0.90) / [0] | exception_raised (0.55) / wrong_value | no_exception | pass | - | **passes_on_base** | $0.0001 / 177.3694170000017 ms | 0.3 |
| pylint-dev__pylint-6386 | 3 (output, output, output) | none / [0] | exception_raised (0.80) / exception_raised | - | - | - | **no_pick** | $0.0001 / 182.02133300000423 ms | 0.2 |
| psf__requests-1142 | 0 () | - / [] | - / wrong_value | - | - | - | **no_blocks** | - | 0.0 |
| psf__requests-2931 | 1 (code) | 0 (0.85) / [0] | exception_raised (1.00) / exception_raised | no_exception | fail: UnicodeDecodeError: 'ascii' codec can't  | PASS | **valid** | $0.0001 / 206.04275000000052 ms | 0.8 |
