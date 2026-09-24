| instance | blocks (kinds) | Jev pick (p) / label | kind (p) / label | criterion | base | gold | outcome | Jev $ / ms | wall s |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| sympy__sympy-12096 | 1 (repl) | 0 (0.93) / [0] | wrong_value (0.86) / wrong_value | differs_from_actual (weak) | fail: f(g(2)) | PASS | **valid_weak** | $0.0001 / 377.663458 ms | 2.4 |
| sympy__sympy-15345 | 1 (code) | 0 (0.68) / [0] | wrong_value (1.00) / wrong_value | values | fail: 'Max(2, x)' | PASS | **valid** | $0.0001 / 165.04062499999964 ms | 3.7 |
| sympy__sympy-17139 | 1 (repl) | 0 (0.88) / [0] | exception_raised (1.00) / exception_raised | no_exception | fail: TypeError: Invalid comparison of complex | PASS | **valid** | $0.0003 / 185.06624999999985 ms | 4.0 |
| sympy__sympy-19954 | 3 (code, traceback, code) | 0 (0.92) / [0,2] | exception_raised (1.00) / exception_raised | no_exception | fail: IndexError: list assignment index out of | PASS | **valid** | $0.0002 / 204.03266599999915 ms | 3.8 |
| sympy__sympy-11618 | 1 (repl) | 0 (0.74) / [0] | wrong_value (1.00) / wrong_value | values | fail: 1 | PASS | **valid** | $0.0001 / 249.0813330000001 ms | 3.0 |
| sympy__sympy-13798 | 2 (repl, repl) | none / [] | none_of_these (0.88) / none_of_these | - | - | - | **no_pick** | $0.0001 / 209.97820899999715 ms | 0.2 |
| sympy__sympy-16792 | 4 (code, code, output, code) | 0 (0.95) / [0] | exception_raised (0.95) / exception_raised | no_exception | fail: CodeWrapError: Error while executing com | fail: CodeWrapError: Error while executing com | **fails_on_gold** | $0.0002 / 697.1491249999999 ms | 4.5 |
| sympy__sympy-20428 | 7 (repl, repl, repl, repl, repl, repl, repl) | 0 (0.85) / [1,2,5] | exception_raised (0.50) / wrong_value | no_exception | pass | - | **passes_on_base** | $0.0005 / 303.7113750000026 ms | 6.0 |
| sympy__sympy-22080 | 1 (repl) | 0 (0.87) / [0] | wrong_value (1.00) / wrong_value | differs_from_actual (weak) | pass | - | **passes_on_base** | $0.0001 / 219.58474999999817 ms | 1.2 |
| sympy__sympy-12489 | 0 () | - / [] | - / none_of_these | - | - | - | **no_blocks** | - | 0.0 |
| django__django-14787 | 1 (code) | none / [0] | exception_raised (1.00) / exception_raised | - | - | - | **no_pick** | $0.0001 / 255.36879200000112 ms | 0.3 |
| django__django-15315 | 1 (code) | 0 (0.85) / [0] | exception_raised (1.00) / exception_raised | no_exception | fail: AssertionError:  | PASS | **valid** | $0.0001 / 156.5436669999981 ms | 0.9 |
| django__django-15572 | 0 () | - / [] | - / wrong_value | - | - | - | **no_blocks** | - | 0.0 |
| django__django-16100 | 0 () | - / [] | - / none_of_these | - | - | - | **no_blocks** | - | 0.0 |
| django__django-14725 | 0 () | - / [] | - / none_of_these | - | - | - | **no_blocks** | - | 0.0 |
| django__django-15103 | 0 () | - / [] | - / none_of_these | - | - | - | **no_blocks** | - | 0.0 |
| django__django-15375 | 2 (repl, repl) | 1 (0.78) / [1] | exception_raised (1.00) / exception_raised | no_exception | fail: NameError: name 'Book' is not defined | fail: NameError: name 'Book' is not defined | **fails_on_gold** | $0.0001 / 172.15079100000003 ms | 1.9 |
| django__django-15563 | 2 (code, repl) | 1 (0.74) / [1] | wrong_value (0.97) / wrong_value | differs_from_actual (weak) | fail: NameError: name 'OtherBase' is not defin | fail: NameError: name 'OtherBase' is not defin | **fails_on_gold** | $0.0001 / 175.77466599999752 ms | 2.3 |
| django__django-15916 | 1 (code) | none / [0] | wrong_value (0.87) / wrong_value | - | - | - | **no_pick** | $0.0001 / 161.43645800000377 ms | 0.2 |
| django__django-15128 | 1 (code) | 0 (0.75) / [0] | exception_raised (1.00) / exception_raised | no_exception | fail: AssertionError:  | PASS | **valid** | $0.0001 / 453.6774580000056 ms | 1.9 |
| pytest-dev__pytest-10081 | 5 (code, output, output, traceback, output) | 0 (0.66) / [0] | exception_raised (1.00) / none_of_these | no_exception | pass | - | **passes_on_base** | $0.0002 / 189.04416700000002 ms | 0.6 |
| pytest-dev__pytest-7205 | 2 (code, traceback) | 0 (0.74) / [0] | exception_raised (1.00) / exception_raised | no_exception | pass | - | **passes_on_base** | $0.0004 / 301.1096249999973 ms | 0.8 |
| pytest-dev__pytest-10051 | 2 (code, output) | 0 (0.93) / [0] | exception_raised (0.92) / exception_raised | no_exception | pass | - | **passes_on_base** | $0.0001 / 302.2845000000016 ms | 0.7 |
| pytest-dev__pytest-7324 | 1 (repl) | 0 (0.61) / [0] | exception_raised (0.91) / exception_raised | no_exception | fail: NameError: name 'Expression' is not defi | fail: NameError: name 'Expression' is not defi | **fails_on_gold** | $0.0001 / 179.24212499999703 ms | 0.6 |
| pytest-dev__pytest-10356 | 2 (code, code) | none / [0,1] | wrong_value (0.93) / wrong_value | - | - | - | **no_pick** | $0.0002 / 175.59650000000693 ms | 0.2 |
| pylint-dev__pylint-4970 | 0 () | - / [] | - / wrong_value | - | - | - | **no_blocks** | - | 0.0 |
| pylint-dev__pylint-4604 | 3 (code, output, output) | 0 (0.90) / [0] | exception_raised (0.51) / wrong_value | no_exception | pass | - | **passes_on_base** | $0.0001 / 133.9307500000068 ms | 0.2 |
| pylint-dev__pylint-6386 | 3 (output, output, output) | none / [0] | exception_raised (0.81) / exception_raised | - | - | - | **no_pick** | $0.0001 / 179.18925000000309 ms | 0.2 |
| psf__requests-1142 | 0 () | - / [] | - / wrong_value | - | - | - | **no_blocks** | - | 0.0 |
| psf__requests-2931 | 1 (code) | 0 (0.85) / [0] | exception_raised (1.00) / exception_raised | no_exception | fail: UnicodeDecodeError: 'ascii' codec can't  | PASS | **valid** | $0.0001 / 153.8353750000024 ms | 0.9 |
