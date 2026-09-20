#!/usr/bin/env python3
"""QuixBugs (Python) test runner. Standard library only; Python 3.9+.

    python3 run_tests.py <name> <path-to-candidate-program.py> [--timeout 2] [--slow] [--max-failures 5] [--jobs N]

Prints exactly one JSON line on stdout:

    {"name", "passed", "failed", "errors", "timeouts", "skipped", "total", "failures": [{"input", "expected", "actual"}]}

and exits 0 iff every non-skipped test passed (1 otherwise, 2 on usage/data errors).

* JSON programs (tests/<name>.json): every test case runs in its own subprocess with a
  wall-clock timeout, so infinite loops and runaway allocation are killed. The candidate
  is imported from <path> under the module name <name>; `fn = getattr(module, name)`;
  `actual = fn(*deepcopy(input))`; a generator result is materialised with list();
  comparison is `actual == expected`, except `sqrt` uses `abs(actual - expected) <= epsilon`
  (epsilon = last input) and `hanoi` compares against `[tuple(x) for x in expected]`.
  Cases flagged `"slow": true` are skipped unless --slow; a case may carry `"timeout": S`
  raising its limit above --timeout. This mirrors QuixBugs' python_testcases/test_<name>.py
  (see README).
* pytest-style programs (tests/<name>_test.py): the test module runs in one subprocess,
  its `test*` functions are called in definition order (some share module state, exactly
  as under pytest), each under a SIGALRM timeout; the whole module additionally has a
  wall-clock limit. programs/ is on sys.path so `from node import Node` resolves.
"""
import argparse
import copy
from concurrent.futures import ThreadPoolExecutor
import importlib.util
import json
import os
import re
import signal
import subprocess
import sys
import traceback
import types

HERE = os.path.dirname(os.path.abspath(__file__))
TESTS_DIR = os.path.join(HERE, "tests")
PROGRAMS_DIR = os.path.join(HERE, "programs")


# --------------------------------------------------------------------------- child side

class _Timeout(BaseException):
    """Raised by the SIGALRM handler; BaseException so `except Exception` cannot swallow it."""


def _alarm(signum, frame):
    raise _Timeout()


def _load_candidate(name, path):
    if PROGRAMS_DIR not in sys.path:
        sys.path.insert(0, PROGRAMS_DIR)
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def _exc_text(exc, test_file=None):
    text = f"{type(exc).__name__}: {exc}".rstrip(": ")
    if test_file is not None:
        frames = [f for f in traceback.extract_tb(exc.__traceback__)
                  if os.path.abspath(f.filename) == os.path.abspath(test_file)]
        if frames:
            f = frames[-1]
            text += f" (at {os.path.basename(f.filename)}:{f.lineno}: {f.line.strip()})"
    return text


def _compare(name, actual, expected, inp):
    if name == "sqrt":
        epsilon = inp[-1]
        try:
            return abs(actual - expected) <= epsilon
        except TypeError:
            return False
    if name == "hanoi":
        expected = [tuple(x) for x in expected]
    try:
        return bool(actual == expected)
    except Exception:
        return False


def _child_json(name, path):
    """stdin: {"input": [...], "expected": ...} -> stdout: {"status", "actual"}"""
    proto = os.fdopen(os.dup(1), "w")
    sys.stdout = sys.stderr  # anything the candidate prints must not corrupt the protocol
    case = json.loads(sys.stdin.read())
    try:
        module = _load_candidate(name, path)
        fn = getattr(module, name)
        actual = fn(*copy.deepcopy(case["input"]))
        if isinstance(actual, types.GeneratorType):
            actual = list(actual)
        status = "pass" if _compare(name, actual, case["expected"], case["input"]) else "fail"
        result = {"status": status, "actual": repr(actual)}
    except BaseException as exc:  # noqa: BLE001 - report everything, incl. RecursionError, SystemExit
        result = {"status": "error", "actual": _exc_text(exc)}
    proto.write(json.dumps(result) + "\n")
    proto.flush()


def _child_module(name, path, test_file, timeout):
    """stdout: header {"tests": [[fn, doc], ...]} then one {"test", "status", "actual"} per test."""
    proto = os.fdopen(os.dup(1), "w")
    sys.stdout = sys.stderr
    try:
        _load_candidate(name, path)
        spec = importlib.util.spec_from_file_location(f"{name}_test", test_file)
        tmod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(tmod)
    except BaseException as exc:  # noqa: BLE001
        proto.write(json.dumps({"import_error": _exc_text(exc, test_file)}) + "\n")
        proto.flush()
        return
    tests = [(k, v) for k, v in vars(tmod).items()
             if k.startswith("test") and isinstance(v, types.FunctionType)]
    proto.write(json.dumps({"tests": [[k, (v.__doc__ or "").strip().splitlines()[0] if v.__doc__ else ""]
                                      for k, v in tests]}) + "\n")
    proto.flush()
    signal.signal(signal.SIGALRM, _alarm)
    for k, fn in tests:
        signal.setitimer(signal.ITIMER_REAL, timeout)
        try:
            fn()
            result = {"test": k, "status": "pass", "actual": "pass"}
        except _Timeout:
            result = {"test": k, "status": "timeout", "actual": f"TIMEOUT after {timeout:g}s"}
        except AssertionError as exc:
            result = {"test": k, "status": "fail", "actual": _exc_text(exc, test_file)}
        except BaseException as exc:  # noqa: BLE001
            result = {"test": k, "status": "error", "actual": _exc_text(exc, test_file)}
        finally:
            signal.setitimer(signal.ITIMER_REAL, 0)
        proto.write(json.dumps(result) + "\n")
        proto.flush()


# --------------------------------------------------------------------------- parent side

def _spawn(argv, stdin_text, timeout):
    """Run a child; return (stdout_text, timed_out)."""
    try:
        cp = subprocess.run([sys.executable, os.path.abspath(__file__)] + argv, input=stdin_text,
                            capture_output=True, text=True, timeout=timeout)
        return cp.stdout, cp.stderr, False
    except subprocess.TimeoutExpired as e:
        out = e.stdout.decode() if isinstance(e.stdout, bytes) else (e.stdout or "")
        err = e.stderr.decode() if isinstance(e.stderr, bytes) else (e.stderr or "")
        return out, err, True


def _last_json_line(text):
    for line in reversed(text.splitlines()):
        line = line.strip()
        if line.startswith("{"):
            try:
                return json.loads(line)
            except json.JSONDecodeError:
                pass
    return None


def _run_json_case(name, path, case, timeout, include_slow):
    if case.get("slow") and not include_slow:
        return {"status": "skipped", "actual": "skipped (slow; pass --slow)"}
    timeout = max(timeout, float(case.get("timeout", 0)))  # optional per-case override (README)
    out, err, timed_out = _spawn(["--_child-json", name, path], json.dumps(case), timeout)
    if timed_out:
        return {"status": "timeout", "actual": f"TIMEOUT after {timeout:g}s"}
    return _last_json_line(out) or {"status": "error",
                                    "actual": "child produced no result: " + err.strip()[-300:]}


def run_json(name, path, timeout, include_slow, jobs):
    with open(os.path.join(TESTS_DIR, f"{name}.json")) as f:
        cases = json.load(f)
    # One subprocess per case; run them concurrently (each is independent) so a hanging
    # candidate costs ~timeout seconds overall rather than timeout * len(cases).
    with ThreadPoolExecutor(max_workers=max(1, jobs)) as ex:
        results = list(ex.map(lambda c: _run_json_case(name, path, c, timeout, include_slow), cases))
    return [{"input": c["input"], "expected": c["expected"], **r} for c, r in zip(cases, results)]


def run_module(name, path, timeout):
    test_file = os.path.join(TESTS_DIR, f"{name}_test.py")
    with open(test_file) as f:
        expected_names = re.findall(r"^def (test\w*)\(", f.read(), re.M)
    overall = timeout * (len(expected_names) + 1) + 5
    out, err, timed_out = _spawn(["--_child-module", name, path, "--timeout", str(timeout)], "", overall)
    lines = []
    for line in out.splitlines():
        try:
            lines.append(json.loads(line))
        except json.JSONDecodeError:
            pass
    if lines and "import_error" in lines[0]:
        return [{"input": t, "expected": "pass", "status": "error",
                 "actual": "import error: " + lines[0]["import_error"]} for t in expected_names]
    header = lines[0]["tests"] if lines and "tests" in lines[0] else [[t, ""] for t in expected_names]
    docs = {t: d for t, d in header}
    seen = {l["test"]: l for l in lines[1:] if "test" in l}
    results = []
    for t, _ in header:
        label = f"{t}: {docs[t]}" if docs.get(t) else t
        if t in seen:
            r = seen[t]
        elif timed_out:
            r = {"status": "timeout", "actual": f"TIMEOUT (module wall-clock {overall:g}s exceeded)"}
        else:
            r = {"status": "error", "actual": "no result from child: " + err.strip()[-300:]}
        results.append({"input": label, "expected": "pass", "status": r["status"], "actual": r["actual"]})
    return results


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("name")
    ap.add_argument("path")
    ap.add_argument("--timeout", type=float, default=2.0, help="seconds per test (default 2)")
    ap.add_argument("--slow", action="store_true", help="also run cases flagged slow (knapsack, levenshtein)")
    ap.add_argument("--max-failures", type=int, default=5, help="failures to include in the JSON (default 5)")
    ap.add_argument("--jobs", type=int, default=min(8, os.cpu_count() or 1),
                    help="concurrent test-case subprocesses for JSON programs (default min(8, cpus))")
    ap.add_argument("--_child-json", action="store_true", help=argparse.SUPPRESS)
    ap.add_argument("--_child-module", action="store_true", help=argparse.SUPPRESS)
    args = ap.parse_args(argv)

    name, path = args.name, os.path.abspath(args.path)
    if args._child_json:
        _child_json(name, path)
        return 0
    if args._child_module:
        _child_module(name, path, os.path.join(TESTS_DIR, f"{name}_test.py"), args.timeout)
        return 0

    json_tests = os.path.join(TESTS_DIR, f"{name}.json")
    module_tests = os.path.join(TESTS_DIR, f"{name}_test.py")
    if not os.path.isfile(path):
        print(json.dumps({"name": name, "error": f"candidate not found: {path}"}))
        return 2
    if os.path.isfile(json_tests):
        results = run_json(name, path, args.timeout, args.slow, args.jobs)
    elif os.path.isfile(module_tests):
        results = run_module(name, path, args.timeout)
    else:
        print(json.dumps({"name": name, "error": f"no tests for {name} in {TESTS_DIR}"}))
        return 2

    counts = {s: sum(r["status"] == s for r in results) for s in ("pass", "fail", "error", "timeout", "skipped")}
    report = {
        "name": name,
        "passed": counts["pass"],
        "failed": counts["fail"],
        "errors": counts["error"] + counts["timeout"],
        "timeouts": counts["timeout"],
        "skipped": counts["skipped"],
        "total": len(results),
        "failures": [{"input": r["input"], "expected": r["expected"], "actual": r["actual"]}
                     for r in results if r["status"] not in ("pass", "skipped")][:args.max_failures],
    }
    print(json.dumps(report))
    ok = report["total"] > 0 and report["failed"] == 0 and report["errors"] == 0
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
