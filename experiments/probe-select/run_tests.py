"""Run a variant of a QuixBugs program against its tests; print one JSON object.

usage: python3 run_tests.py <program> <variant_source_file> [max_tests] [timeout_s]

JSON programs (json_testcases/<p>.json): each row -> {kind:'json', input, expected, actual, status}
Graph programs (python_testcases/test_<p>.py, Node based): each test function ->
  {kind:'pytest', name, source, expected (assert lines), actual, status}
status in: pass | wrong_output | exception | timeout
"""
import copy, importlib.util, inspect, json, math, os, re, signal, sys, tempfile, textwrap, traceback, types

ROOT = '/tmp/quixbugs'
program, variant = sys.argv[1], sys.argv[2]
max_tests = int(sys.argv[3]) if len(sys.argv) > 3 else 10**6
timeout_s = int(sys.argv[4]) if len(sys.argv) > 4 else 2
sys.setrecursionlimit(3000)

class Timeout(Exception):
    pass

def _alarm(signum, frame):
    raise Timeout()

signal.signal(signal.SIGALRM, _alarm)

def norm(v):
    """JSON-normalise (tuples -> lists, generators -> lists, floats rounded)."""
    if isinstance(v, (types.GeneratorType, map, filter, range, set, frozenset)):
        v = list(v)
    if isinstance(v, dict):
        return {str(k): norm(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [norm(x) for x in v]
    if isinstance(v, float):
        return round(v, 6)
    if isinstance(v, bool) or v is None or isinstance(v, (int, str)):
        return v
    return repr(v)

def short(v, n=300):
    s = json.dumps(v) if not isinstance(v, str) else v
    return s if len(s) <= n else s[:n] + '...'

# --- load the variant as module `python_programs.<program>` from a temp tree -----------
tmp = tempfile.mkdtemp(prefix='jevonly-', dir='/tmp/jevonly')
pkg = os.path.join(tmp, 'python_programs')
os.makedirs(pkg)
open(os.path.join(pkg, '__init__.py'), 'w').close()
with open(os.path.join(pkg, program + '.py'), 'w') as f:
    f.write(open(variant).read())
with open(os.path.join(pkg, 'node.py'), 'w') as f:
    f.write(open(os.path.join(ROOT, 'python_programs', 'node.py')).read())
sys.path.insert(0, tmp)
sys.path.insert(0, pkg)

fake_pytest = types.ModuleType('pytest')
fake_pytest.use_correct = False
fake_pytest.run_slow = False
class _Approx:
    def __init__(self, e, abs=1e-6, rel=None):
        self.e, self.abs = e, abs
    def __eq__(self, o):
        try:
            return math.isclose(o, self.e, abs_tol=self.abs)
        except Exception:
            return False
fake_pytest.approx = _Approx
sys.modules['pytest'] = fake_pytest

results = []
def run(fn, *args):
    signal.alarm(timeout_s)
    try:
        r = fn(*args)
        return 'ok', norm(r)
    except Timeout:
        return 'timeout', f'no result after {timeout_s}s (infinite loop or hang)'
    except RecursionError:
        return 'exception', 'RecursionError: maximum recursion depth exceeded (unbounded recursion)'
    except AssertionError as e:
        return 'assert', str(e)
    except Exception as e:
        return 'exception', f'{type(e).__name__}: {str(e)[:200]}'
    finally:
        signal.alarm(0)

json_path = os.path.join(ROOT, 'json_testcases', program + '.json')
try:
    spec = importlib.util.spec_from_file_location(f'python_programs.{program}', os.path.join(pkg, program + '.py'))
    mod = importlib.util.module_from_spec(spec)
    sys.modules[f'python_programs.{program}'] = mod
    spec.loader.exec_module(mod)
    load_error = None
except Exception as e:
    load_error = f'{type(e).__name__}: {str(e)[:200]}'

if os.path.exists(json_path):
    rows = [json.loads(l) for l in open(json_path) if l.strip()][:max_tests]
    for args, expected in rows:
        if load_error:
            results.append({'kind': 'json', 'input': args, 'expected': expected, 'actual': load_error, 'status': 'exception'})
            continue
        fn = getattr(mod, program)
        st, r = run(fn, *copy.deepcopy(args))
        if st == 'ok':
            actual = r
            ok = actual == norm(expected)
            if not ok and program == 'sqrt':
                ok = isinstance(r, (int, float)) and math.isclose(r, expected, abs_tol=args[-1])
            results.append({'kind': 'json', 'input': args, 'expected': expected, 'actual': actual, 'status': 'pass' if ok else 'wrong_output'})
        else:
            results.append({'kind': 'json', 'input': args, 'expected': expected, 'actual': r, 'status': 'timeout' if st == 'timeout' else 'exception'})
else:
    tpath = os.path.join(ROOT, 'python_testcases', f'test_{program}.py')
    src = open(tpath).read()
    tmod = types.ModuleType(f'test_{program}')
    tmod.__file__ = tpath
    sys.path.insert(0, os.path.join(ROOT, 'python_testcases'))
    if load_error:
        exec_error = load_error
    else:
        try:
            exec(compile(src, tpath, 'exec'), tmod.__dict__)
            exec_error = None
        except Exception as e:
            exec_error = f'{type(e).__name__}: {str(e)[:200]}'
    names = [n for n in re.findall(r'^def (test\w*)\(', src, re.M)][:max_tests]
    for name in names:
        fsrc = textwrap.dedent(inspect.getsource(getattr(tmod, name))) if exec_error is None and hasattr(tmod, name) else ''
        if not fsrc:
            m = re.search(rf'^def {name}\(.*?(?=^def |\Z)', src, re.M | re.S)
            fsrc = m.group(0).rstrip() if m else ''
        expected = [l.strip() for l in fsrc.split('\n') if l.strip().startswith('assert')]
        doc = re.search(r'Output: (.*)', fsrc)
        if doc:
            expected.insert(0, 'Output: ' + doc.group(1).strip())
        if exec_error:
            results.append({'kind': 'pytest', 'name': name, 'source': fsrc, 'expected': expected, 'actual': exec_error, 'status': 'exception'})
            continue
        st, r = run(getattr(tmod, name))
        if st == 'ok':
            results.append({'kind': 'pytest', 'name': name, 'source': fsrc, 'expected': expected, 'actual': 'all assertions passed', 'status': 'pass'})
        elif st == 'assert':
            results.append({'kind': 'pytest', 'name': name, 'source': fsrc, 'expected': expected, 'actual': 'AssertionError: an assert in this test failed' + (f' ({r})' if r else ''), 'status': 'wrong_output'})
        else:
            results.append({'kind': 'pytest', 'name': name, 'source': fsrc, 'expected': expected, 'actual': r, 'status': 'timeout' if st == 'timeout' else 'exception'})

print(json.dumps({'program': program, 'tests': results, 'all_pass': all(t['status'] == 'pass' for t in results) and len(results) > 0}))
