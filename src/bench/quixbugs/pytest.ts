/**
 * The pytest layout written into a QuixBugs workspace so the agent's detected test command
 * (`pytest -q`, from pytest.ini) works and the judge sees pass/fail counts: a generated
 * `tests/test_<name>.py` for the JSON programs (one parametrised test with QuixBugs' leniency:
 * generators materialised, tuples compared as lists, `sqrt` with the epsilon argument as
 * absolute tolerance, slow cases skipped, a per-case alarm so a hanging candidate fails
 * instead of hanging the run, the alarm's limit and a stop-after-N-timeouts rule readable from
 * the environment for the synthesizer's shadow lanes, RecursionError re-raised shallow so pytest
 * does not spend 150 ms rendering each thousand-frame traceback). pytest.ini and conftest.py
 * come from ../ladder/pyworkspace.ts. Nothing here is the oracle: the evaluator runs
 * bench/data/quixbugs/run_tests.py at its defaults.
 */
import { CASE_TIMEOUT_ENV, MAX_CASE_TIMEOUTS_ENV } from '../../synth/verify/quixbugs.js';
import type { QuixbugsCase } from './tasks.js';

export { CASE_TIMEOUT_ENV, MAX_CASE_TIMEOUTS_ENV };

/** Default per-case wall-clock limit, the same as run_tests.py's --timeout. */
export const CASE_TIMEOUT_S = 2;
export const DEFAULT_CASE_TIMEOUT_MS = CASE_TIMEOUT_S * 1000;
/*
 * Two environment knobs, read by the generated module at import and set only by the
 * synthesizer's shadow lanes (src/synth/sieve/runner.ts); unset, as under the agent's own
 * `pytest -q` and the engine's `run` proposals, the module behaves as before. Grading never
 * sees them: the evaluator runs bench/data/quixbugs/run_tests.py at its 2 s default.
 *
 * - CASE_TIMEOUT_ENV (JEVCODE_CASE_TIMEOUT_MS): the per-case limit in milliseconds, the oracle's
 *   adaptive per-test timeout (docs/JEV-ONLY-DESIGN.md §4.1: clamp(3 × baseline per-test p50 of
 *   the cases that finished, 0.5 s, 2 s)); default 2 s.
 * - MAX_CASE_TIMEOUTS_ENV (JEVCODE_MAX_CASE_TIMEOUTS): after this many case timeouts in one run
 *   the remaining cases are reported as failures ("CaseNotRun: not run: N earlier case(s) timed
 *   out") without being called; default no limit. Why: a candidate that hangs on one input hangs
 *   on the others too (bitcount 9/9, sqrt 6/7 cases in the buggy baselines) and pytest runs the
 *   cases sequentially, so without the rule a hanging candidate costs cases × limit (bitcount:
 *   9 × 2 s = 18 s, the 18.7 s baseline of the first live bench) and the run-cost rule of §2.4
 *   falls to RANK mode; with it a hanging candidate costs one limit plus process start (≈ 0.7 s)
 *   and the whole first-order set runs (the sieve). What is lost: whether a candidate that hangs
 *   on an early case would pass a later one; such a candidate is never plausible, and a
 *   timed-out run is never held as a base (§4.1).
 */

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


def _env_number(var, default):
    raw = os.environ.get(var, "").strip()
    if not raw:
        return default
    try:
        return float(raw)
    except ValueError:
        return default


# Per-case limit: ${CASE_TIMEOUT_ENV} (ms) when set, else ${CASE_TIMEOUT_S} s (run_tests.py's default).
CASE_TIMEOUT_S = max(0.001, _env_number(${py(CASE_TIMEOUT_ENV)}, ${DEFAULT_CASE_TIMEOUT_MS}) / 1000.0)
# Stop rule: after ${MAX_CASE_TIMEOUTS_ENV} case timeouts the remaining cases fail as "not run" (unset: no limit).
MAX_CASE_TIMEOUTS = _env_number(${py(MAX_CASE_TIMEOUTS_ENV)}, float("inf"))
_TIMEOUTS_SEEN = [0]
# sqrt: |actual - expected| <= epsilon, where epsilon is the last argument (QuixBugs' rule)
ABS_TOLERANCE_FROM_LAST_ARG = ${approx ? 'True' : 'False'}

with open(os.path.join(HERE, ${py(casesFileName(name))})) as _f:
    CASES = json.load(_f)
assert len(CASES) == ${cases.length}


class CaseTimeout(BaseException):
    """BaseException so a candidate's \`except Exception\` cannot swallow it."""


class CaseNotRun(BaseException):
    """A case skipped by the stop rule (MAX_CASE_TIMEOUTS): reported as a failure, never called."""


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
    if _TIMEOUTS_SEEN[0] >= MAX_CASE_TIMEOUTS:
        raise CaseNotRun("not run: %d earlier case(s) timed out" % _TIMEOUTS_SEEN[0])
    limit = max(CASE_TIMEOUT_S, float(case.get("timeout", 0)))
    try:
        with time_limit(limit):
            try:
                actual = ${name}(*copy.deepcopy(case["input"]))
                if isinstance(actual, types.GeneratorType):
                    actual = list(actual)
            except RecursionError as exc:
                # The message is the finding; the thousand-frame traceback is not. Re-raised
                # shallow, pytest reports the case in ~10 ms instead of ~150 ms (mergesort:
                # 13 such cases took the buggy baseline to 2 s idle, 5 s under bench load).
                raise RecursionError(str(exc)) from None
    except CaseTimeout:
        _TIMEOUTS_SEEN[0] += 1
        raise
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
