#!/usr/bin/env python3
"""QuixBugs test runner for candidate programs (no pytest needed).

Usage:
  run_tests.py <candidate.py> <program> [--timeout 2] [--quixbugs /tmp/quixbugs]
    -> prints JSON {program, total, passed, failed, tests:[{id, input, expected, actual, status}]}
       status in pass | fail | error | timeout. `actual` is the returned value (repr) or the
       exception text. Each test runs in its own subprocess with the timeout.
  run_tests.py --one <candidate.py> <program> <idx>   (internal: run one test, print JSON)

Programs with json_testcases/<program>.json are run as f(*args) == expected (sqrt uses the
abs tolerance of its last argument, as QuixBugs' test does). The 9 graph/list programs
(breadth_first_search, depth_first_search, detect_cycle, minimum_spanning_tree,
reverse_linked_list, shortest_path_length, shortest_path_lengths, shortest_paths,
topological_ordering) are run through their python_testcases/test_<program>.py functions with
a stub `pytest` module; `input` is the docstring case line and `expected` the docstring output.
"""
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import types
from concurrent.futures import ThreadPoolExecutor

QB = os.environ.get("QUIXBUGS", "/tmp/quixbugs")


def load_json_tests(program):
    p = os.path.join(QB, "json_testcases", f"{program}.json")
    if not os.path.exists(p):
        return None
    with open(p) as f:
        return [json.loads(line) for line in f if line.strip()]


def graph_test_names(program):
    src = open(os.path.join(QB, "python_testcases", f"test_{program}.py")).read()
    names, docs = [], {}
    lines = src.split("\n")
    for i, line in enumerate(lines):
        if line.startswith("def test"):
            name = line[4:line.index("(")]
            names.append(name)
            doc = []
            j = i + 1
            if j < len(lines) and '"""' in lines[j]:
                doc.append(lines[j].strip().strip('"').strip())
                j += 1
                while j < len(lines) and '"""' not in lines[j]:
                    doc.append(lines[j].strip())
                    j += 1
            docs[name] = doc
    return names, docs


def describe_graph_test(program, name, docs):
    doc = docs.get(name, [])
    case = doc[0] if doc else name
    out = " ".join(d for d in doc[1:] if d)
    return case, out or "(see test)"


def run_one(candidate, program, idx):
    """Run a single test in-process; return dict."""
    tests = load_json_tests(program)
    if tests is not None:
        args, expected = tests[idx]
        spec = importlib.util.spec_from_file_location(program, candidate)
        mod = importlib.util.module_from_spec(spec)
        try:
            spec.loader.exec_module(mod)
            fn = getattr(mod, program)
            actual = fn(*args) if isinstance(args, list) else fn(args)
            if hasattr(actual, "__next__"):  # QuixBugs tests wrap generator results in list()
                actual = list(actual)
            if program == "sqrt":
                ok = abs(actual - expected) <= args[-1]
            else:
                # QuixBugs tests compare with ==; tuples returned vs lists expected count as equal
                ok = normalise(actual) == normalise(expected)
            return {"input": args, "expected": expected, "actual": safe_repr(actual), "status": "pass" if ok else "fail"}
        except Exception as e:  # noqa: BLE001
            return {"input": args, "expected": expected, "actual": f"{type(e).__name__}: {str(e)[:200]}", "status": "error"}
    # graph program: build a temp package layout
    names, docs = graph_test_names(program)
    name = names[idx]
    case, out = describe_graph_test(program, name, docs)
    tmp = tempfile.mkdtemp(prefix="qbrun-", dir="/tmp/jevonly")
    try:
        os.makedirs(os.path.join(tmp, "python_programs"))
        open(os.path.join(tmp, "python_programs", "__init__.py"), "w").close()
        shutil.copy(candidate, os.path.join(tmp, "python_programs", f"{program}.py"))
        shutil.copy(os.path.join(QB, "python_testcases", "node.py"), os.path.join(tmp, "python_programs", "node.py"))
        shutil.copy(os.path.join(QB, "python_testcases", "node.py"), os.path.join(tmp, "node.py"))
        shutil.copy(os.path.join(QB, "python_testcases", f"test_{program}.py"), os.path.join(tmp, f"test_{program}.py"))
        stub = types.ModuleType("pytest")
        stub.use_correct = False
        stub.run_slow = False
        sys.modules["pytest"] = stub
        sys.path.insert(0, tmp)
        spec = importlib.util.spec_from_file_location(f"test_{program}", os.path.join(tmp, f"test_{program}.py"))
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        getattr(mod, name)()
        return {"input": case, "expected": out, "actual": "assertion held", "status": "pass"}
    except AssertionError as e:
        return {"input": case, "expected": out, "actual": f"AssertionError: {str(e)[:200] or 'assertion failed'}", "status": "fail"}
    except Exception as e:  # noqa: BLE001
        return {"input": case, "expected": out, "actual": f"{type(e).__name__}: {str(e)[:200]}", "status": "error"}
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def normalise(v):
    if isinstance(v, (list, tuple)):
        return [normalise(x) for x in v]
    if isinstance(v, set):
        return sorted(safe_repr(x) for x in v)
    return v


def safe_repr(v):
    try:
        if isinstance(v, (list, tuple, dict, set, str, int, float, bool)) or v is None:
            return json.loads(json.dumps(v, default=repr))
        return repr(v)
    except Exception:  # noqa: BLE001
        return repr(v)


def test_count(program):
    tests = load_json_tests(program)
    if tests is not None:
        return len(tests)
    return len(graph_test_names(program)[0])


def run_all(candidate, program, timeout=2.0):
    n = test_count(program)

    def one(i):
        try:
            r = subprocess.run([sys.executable, __file__, "--one", candidate, program, str(i)], capture_output=True, text=True, timeout=timeout)
            if r.returncode != 0 or not r.stdout.strip():
                return {"id": i, "input": placeholder_input(program, i), "expected": placeholder_expected(program, i), "actual": f"crash: {r.stderr.strip()[-200:]}", "status": "error"}
            d = json.loads(r.stdout.strip().split("\n")[-1])
            d["id"] = i
            return d
        except subprocess.TimeoutExpired:
            return {"id": i, "input": placeholder_input(program, i), "expected": placeholder_expected(program, i), "actual": f"timeout after {timeout}s (no result)", "status": "timeout"}

    with ThreadPoolExecutor(max_workers=8) as ex:
        results = list(ex.map(one, range(n)))
    passed = sum(1 for r in results if r["status"] == "pass")
    first = next((r for r in results if r["status"] != "pass"), None)
    return {"program": program, "total": n, "passed": passed, "failed": n - passed, "first_failure": first, "tests": results}


def placeholder_input(program, i):
    tests = load_json_tests(program)
    if tests is not None:
        return tests[i][0]
    names, docs = graph_test_names(program)
    return describe_graph_test(program, names[i], docs)[0]


def placeholder_expected(program, i):
    tests = load_json_tests(program)
    if tests is not None:
        return tests[i][1]
    names, docs = graph_test_names(program)
    return describe_graph_test(program, names[i], docs)[1]


if __name__ == "__main__":
    a = sys.argv[1:]
    if a and a[0] == "--one":
        sys.setrecursionlimit(4000)
        print(json.dumps(run_one(a[1], a[2], int(a[3]))))
        sys.exit(0)
    timeout = 2.0
    if "--timeout" in a:
        k = a.index("--timeout")
        timeout = float(a[k + 1])
        del a[k:k + 2]
    if "--quixbugs" in a:
        k = a.index("--quixbugs")
        QB = a[k + 1]
        del a[k:k + 2]
    print(json.dumps(run_all(a[0], a[1], timeout), indent=1))
