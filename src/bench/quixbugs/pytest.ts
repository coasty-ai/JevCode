/**
 * The pytest layout written into a QuixBugs workspace so the agent's detected test command
 * (`pytest -q`, from pytest.ini) works and the judge sees pass/fail counts: a generated
 * `tests/test_<name>.py` for the JSON programs (one parametrised test with QuixBugs' leniency:
 * generators materialised, tuples compared as lists, `sqrt` with the epsilon argument as
 * absolute tolerance, slow cases skipped, a per-case alarm so a hanging candidate fails
 * instead of hanging the run). pytest.ini and conftest.py come from ../ladder/pyworkspace.ts.
 * Nothing here is the oracle: the evaluator runs bench/data/quixbugs/run_tests.py.
 */
import type { QuixbugsCase } from './tasks.js';

/** Default per-case wall-clock limit, the same as run_tests.py's --timeout. */
export const CASE_TIMEOUT_S = 2;

export function testFileName(name: string): string {
  return `test_${name}.py`;
}
export function casesFileName(name: string): string {
  return `${name}.json`;
}

/**
 * The generated module. It embeds nothing about the fix; the cases are read from
 * `tests/<name>.json` beside it. Importable without pytest (then `python3 tests/test_<name>.py`
 * runs the cases and exits 1 on the first failure count), parametrised under pytest.
 */
export function generatePytestModule(name: string, cases: readonly QuixbugsCase[]): string {
  const approx = name === 'sqrt';
  const py = (s: string): string => JSON.stringify(s);
  return `"""Tests for \`${name}\` generated from QuixBugs' JSON cases (tests/${casesFileName(name)}).

Run with \`pytest -q\` from the workspace root, or directly with \`python3 tests/${testFileName(name)}\`.
"""
import copy
import json
import os
import signal
import sys
import types
from contextlib import contextmanager

try:
    import pytest
except ImportError:  # plain python: the module still imports and runs the cases from __main__
    pytest = None

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from ${name} import ${name}  # noqa: E402

NAME = ${py(name)}
CASE_TIMEOUT_S = ${CASE_TIMEOUT_S}
# sqrt: |actual - expected| <= epsilon, where epsilon is the last argument (QuixBugs' rule)
ABS_TOLERANCE_FROM_LAST_ARG = ${approx ? 'True' : 'False'}

with open(os.path.join(HERE, ${py(casesFileName(name))})) as _f:
    CASES = json.load(_f)
assert len(CASES) == ${cases.length}


class CaseTimeout(BaseException):
    """BaseException so a candidate's \`except Exception\` cannot swallow it."""


@contextmanager
def time_limit(seconds):
    if not hasattr(signal, "setitimer"):
        yield
        return

    def _alarm(signum, frame):
        raise CaseTimeout("no result after %gs" % seconds)

    previous = signal.signal(signal.SIGALRM, _alarm)
    signal.setitimer(signal.ITIMER_REAL, seconds)
    try:
        yield
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous)


def normalise(value):
    """Tuples and lists compare equal element-wise (QuixBugs' hanoi rule, applied everywhere)."""
    if isinstance(value, (list, tuple)):
        return [normalise(v) for v in value]
    return value


def run_case(case):
    """Call the program on a deep copy of the input and return (actual, expected)."""
    limit = max(CASE_TIMEOUT_S, float(case.get("timeout", 0)))
    with time_limit(limit):
        actual = ${name}(*copy.deepcopy(case["input"]))
        if isinstance(actual, types.GeneratorType):
            actual = list(actual)
    return actual, case["expected"]


def check_case(case):
    actual, expected = run_case(case)
    if ABS_TOLERANCE_FROM_LAST_ARG:
        epsilon = case["input"][-1]
        assert abs(actual - expected) <= epsilon, "%s%r -> %r, expected %r +/- %r" % (NAME, tuple(case["input"]), actual, expected, epsilon)
    else:
        assert normalise(actual) == normalise(expected), "%s%r -> %r, expected %r" % (NAME, tuple(case["input"]), actual, expected)


def case_id(index, case):
    return "%d-%s" % (index, json.dumps(case["input"])[:48])


if pytest is not None:
    _PARAMS = [
        pytest.param(case, id=case_id(i, case), marks=[pytest.mark.skip(reason="slow case, skipped by QuixBugs too")] if case.get("slow") else [])
        for i, case in enumerate(CASES)
    ]

    @pytest.mark.parametrize("case", _PARAMS)
    def test_${name}(case):
        check_case(case)

else:

    def test_${name}():
        for case in CASES:
            if not case.get("slow"):
                check_case(case)


def main():
    failures = 0
    for i, case in enumerate(CASES):
        if case.get("slow"):
            print("SKIP %s" % case_id(i, case))
            continue
        try:
            check_case(case)
            print("PASS %s" % case_id(i, case))
        except AssertionError as exc:
            failures += 1
            print("FAIL %s: %s" % (case_id(i, case), exc))
        except BaseException as exc:  # noqa: BLE001 - report timeouts and crashes alike
            failures += 1
            print("ERROR %s: %s: %s" % (case_id(i, case), type(exc).__name__, exc))
    print("%d case(s), %d failing" % (len(CASES), failures))
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
`;
}
