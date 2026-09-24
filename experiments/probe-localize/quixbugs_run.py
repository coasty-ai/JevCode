"""
Run every QuixBugs buggy Python program against its tests and record actual outputs.

Output: experiments/probe-localize/quixbugs-runs.json
  { program: { kind: 'json'|'graph', tests: [ {input, expected, actual|error|timeout, passed, summary} ... ],
               first_failing: <index or null> } }

JSON-test programs: each test case runs in a fresh subprocess with a 2 s timeout.
Graph programs: the pytest file is executed in one subprocess with a stub `pytest` module
(use_correct=False) and each test function runs under a 2 s SIGALRM timeout, in file order
(the files mutate shared module state, so order matters).
"""
import json, os, subprocess, sys, textwrap, inspect

ROOT = '/tmp/quixbugs'
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'quixbugs-runs.json')
GRAPH = ["breadth_first_search", "depth_first_search", "detect_cycle", "minimum_spanning_tree",
         "reverse_linked_list", "shortest_path_length", "shortest_path_lengths", "shortest_paths",
         "topological_ordering"]

CHILD_JSON = r'''
import json, sys, types, math
sys.path.insert(0, "/tmp/quixbugs")
prog, args = sys.argv[1], json.loads(sys.argv[2])
mod = __import__("python_programs." + prog, fromlist=[prog])
fx = getattr(mod, prog)
def norm(o):
    if isinstance(o, types.GeneratorType): o = list(o)
    if isinstance(o, (list, tuple)): return [norm(x) for x in o]
    if isinstance(o, dict): return {str(k): norm(v) for k, v in o.items()}
    if isinstance(o, set): return sorted(norm(x) for x in o)
    if isinstance(o, float) and (math.isnan(o) or math.isinf(o)): return str(o)
    if isinstance(o, (int, float, str, bool)) or o is None: return o
    return repr(o)
try:
    out = fx(*args) if isinstance(args, list) else fx(args)
    print(json.dumps({"actual": norm(out)}))
except RecursionError as e:
    print(json.dumps({"error": "RecursionError: maximum recursion depth exceeded"}))
except Exception as e:
    print(json.dumps({"error": f"{type(e).__name__}: {e}"[:300]}))
'''

CHILD_GRAPH = r'''
import sys, types, signal, inspect, json, traceback
sys.path.insert(0, "/tmp/quixbugs"); sys.path.insert(0, "/tmp/quixbugs/python_testcases"); sys.path.insert(0, "/tmp/quixbugs/python_programs")
stub = types.ModuleType("pytest"); stub.use_correct = False
class _Mark:
    def __getattr__(self, name):
        def deco(*a, **k):
            return lambda f: f
        return deco
stub.mark = _Mark()
sys.modules["pytest"] = stub
prog = sys.argv[1]
mod = __import__("test_" + prog)
tests = [(n, f) for n, f in vars(mod).items() if n.startswith("test") and callable(f)]
tests.sort(key=lambda nf: nf[1].__code__.co_firstlineno)
class Timeout(Exception): pass
def handler(signum, frame): raise Timeout()
signal.signal(signal.SIGALRM, handler)
rows = []
for name, f in tests:
    doc = inspect.getdoc(f) or ""
    src = inspect.getsource(f)
    row = {"name": name, "doc": doc, "source": src}
    signal.alarm(2)
    try:
        f(); row["passed"] = True
    except Timeout:
        row["passed"] = False; row["timeout"] = True; row["error"] = "Timeout: the test did not finish within 2 seconds (probable infinite loop)"
    except AssertionError as e:
        row["passed"] = False; row["error"] = "AssertionError: the assertion in the test failed" + (f": {e}" if str(e) else "")
    except RecursionError:
        row["passed"] = False; row["error"] = "RecursionError: maximum recursion depth exceeded"
    except Exception as e:
        row["passed"] = False; row["error"] = f"{type(e).__name__}: {e}"[:300]
    finally:
        signal.alarm(0)
    rows.append(row)
print(json.dumps(rows))
'''

def eq(a, b):
    if isinstance(a, float) or isinstance(b, float):
        try: return abs(float(a) - float(b)) < 1e-6
        except Exception: return False
    return json.dumps(a, sort_keys=True) == json.dumps(b, sort_keys=True)

def run_json(prog):
    cases = [json.loads(l) for l in open(f'{ROOT}/json_testcases/{prog}.json') if l.strip()]
    rows = []
    for inp, exp in cases:
        args = inp if isinstance(inp, list) else [inp]
        row = {"input": args, "expected": exp}
        try:
            r = subprocess.run([sys.executable, '-c', CHILD_JSON, prog, json.dumps(args)], capture_output=True, text=True, timeout=2)
            try:
                res = json.loads(r.stdout.strip().splitlines()[-1])
            except Exception:
                res = {"error": ("crash: " + (r.stderr.strip().splitlines() or ["?"])[-1])[:300]}
            row.update(res)
            row["passed"] = ("actual" in res) and (eq(res["actual"], exp) if prog != 'sqrt' else abs(res["actual"] - exp) <= args[-1])
        except subprocess.TimeoutExpired:
            row["timeout"] = True; row["error"] = "Timeout: the program did not finish within 2 seconds (probable infinite loop)"; row["passed"] = False
        rows.append(row)
    return rows

def run_graph(prog):
    r = subprocess.run([sys.executable, '-c', CHILD_GRAPH, prog], capture_output=True, text=True, timeout=60)
    if r.returncode != 0:
        raise RuntimeError(r.stderr)
    return json.loads(r.stdout.strip().splitlines()[-1])

def main():
    progs = sorted(f[:-3] for f in os.listdir(f'{ROOT}/python_programs') if f.endswith('.py') and not f.endswith('_test.py') and f != 'node.py')
    out = {}
    for p in progs:
        kind = 'graph' if p in GRAPH else 'json'
        rows = run_graph(p) if kind == 'graph' else run_json(p)
        ff = next((i for i, r in enumerate(rows) if not r["passed"]), None)
        out[p] = {"kind": kind, "tests": rows, "first_failing": ff}
        print(f'{p:28s} {kind:5s} tests={len(rows):2d} failing={sum(1 for r in rows if not r["passed"]):2d} first_failing={ff} {"" if ff is None else (rows[ff].get("error") or "wrong output: " + json.dumps(rows[ff].get("actual"))[:80])}')
    json.dump(out, open(OUT, 'w'), indent=1)
    print('wrote', OUT)

if __name__ == '__main__':
    main()
